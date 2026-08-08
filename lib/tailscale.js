// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// TailscaleClient: async CLI wrapper that polls `tailscale status --json`
// and emits 'state-changed' when its parsed snapshot mutates. Everything
// goes through spawn.js, the extension's only launch site, so the main
// loop never blocks and every command it can run is listed in one place.
//
// Privileged operations: on Linux the Tailscale daemon only accepts
// state-changing commands from root or from the Unix user named in its
// OperatorUser pref. Three entry points below (setOperator, login, logout)
// therefore run through `pkexec` with a literal, fixed argument vector:
// EGO review requires the full elevated command to be readable in the
// source. The only part not spelled out here is which directory the CLI
// came from: that is resolved by spawn.js and always checked against its
// fixed list of root-owned system directories, never taken on trust from
// $PATH and never from a setting. A Tailscale found anywhere else is run
// unelevated only; the privileged entry points refuse rather than hand it
// to pkexec. Every privileged command is listed verbatim in README.md
// under "Privileged operations".

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

// Nothing in this file starts a process itself: spawn.js is the only
// launch site in the extension, and it also holds the binary lookup so the
// preferences process gets the same answers this one does.
import {
    TAILSCALE_BIN as BIN, PKEXEC_BIN as PKEXEC,
    hasTailscaleCli as _binaryPresent,
    tailscaleBin as _bin, privilegedTailscaleBin as _privBin,
    run as _spawn, runStreaming as _spawnStreaming, readLines as _readLines,
} from './spawn.js';
import { Category } from './notify-policy.js';
import {
    EMPTY_SNAPSHOT, ACCESS_DENIED_RE, isAccessDenied, spawnFailure,
    buildSnapshot, parseFunnels, parseSwitchList, parseWroteLine,
    snapshotEqual,
} from './tailscale-parse.js';

// Poll cadence while the CLI is missing. Nothing observable can change
// until a package manager runs, so the 1–60s the user picked for live
// status would be a PATH walk every few seconds for the whole session.
const MISSING_POLL_SECONDS = 30;

// Goes in snapshot.error, which by contract carries the technical reason
// (elsewhere a line of the CLI's own stderr) and is not translated. The
// user-facing wording keys off snapshot.installed instead; see
// statusText() and the menu's not-installed banner.
const NOT_INSTALLED_ERR = `${BIN}: not found in PATH`;

// Same contract, for the narrower case: a Tailscale is installed and every
// read-only command works, but it sits outside the system directories
// spawn.js is willing to elevate. Surfaced as the failure of the command
// the user asked for, not as a state of the machine, because that is what
// it is: everything else here keeps working.
const NOT_ELEVATABLE_ERR =
    `${BIN}: not in a system directory, refusing to run it as root`;

/* -------------------------------------------------------------------------- */
/*                                  Client                                    */
/* -------------------------------------------------------------------------- */

export const TailscaleClient = GObject.registerClass(
    {
        GTypeName: 'TailscaleClient',
        Signals: {
            'state-changed': { param_types: [GObject.TYPE_JSOBJECT] },
            'error': { param_types: [GObject.TYPE_STRING] },
            // Second param is the Category (see notify-policy.js) the
            // message belongs to, so a single signal can carry the
            // heterogeneous messages emitted below (login, funnel,
            // Taildrop transfers, …) while each stays independently
            // toggleable from Preferences, per notify-policy's contract.
            'notify-info': { param_types: [GObject.TYPE_STRING, GObject.TYPE_STRING] },
            // A Taildrop file has landed: absolute path, size in bytes. Kept
            // apart from notify-info because the message this turns into is
            // built from the path rather than carried by the signal: the
            // wording and its "click to open" hint are translated, and the
            // path itself is what the click handler needs.
            'file-received': { param_types: [GObject.TYPE_STRING, GObject.TYPE_INT64] },
        },
    },
    class TailscaleClient extends GObject.Object {
        _init(params = {}) {
            super._init();
            this._pollSeconds = params.pollSeconds || 5;
            this._settings = params.settings || null;
            this._cancellable = new Gio.Cancellable();
            // Probed here, not left to the first refresh: the toggle renders
            // once from this very snapshot before any poll has landed, and
            // an optimistic default would show it a working-but-disconnected
            // Tailscale for as long as that takes. It also makes the first
            // refresh a no-op rather than a transition, which is what keeps
            // a machine that simply has no Tailscale from being told so at
            // every login; see refresh().
            this._snapshot = _binaryPresent()
                ? { ...EMPTY_SNAPSHOT }
                : { ...EMPTY_SNAPSHOT, installed: false, error: NOT_INSTALLED_ERR };
            this._timerId = 0;
            this._inflight = false;
            // A full refresh asked for while a light one was running; see
            // refresh().
            this._pendingFull = false;
            this._funnelTimeoutIds = new Set();
            // Last successful `switch --list` result. Served as a fallback
            // while the daemon denies the listing (no operator, typically
            // right after a logout) so the menu can keep offering account
            // switching: the switch itself elevates in that state.
            this._knownAccounts = [];
            // What the last full refresh learned from the two commands the
            // timer no longer runs; see refresh().
            this._lastAccounts = { accounts: [], denied: false };
            this._lastFunnels = [];
        }

        /** Most recent normalized snapshot. Always non-null. */
        get snapshot() {
            return this._snapshot;
        }

        setPollSeconds(seconds) {
            const clamped = Math.max(1, Math.min(60, seconds | 0));
            if (clamped === this._pollSeconds) return;
            this._pollSeconds = clamped;
            this._restartTimer();
        }

        /** Begin polling. Idempotent. */
        start() {
            this._restartTimer();
            // Kick off an immediate refresh so the UI never starts blank.
            this.refresh().catch(() => {});
        }

        /** Stop polling, kill owned subprocesses and cancel anything in flight. */
        destroy() {
            this._pendingFull = false;
            this._stopTimer();
            this._stopReceiver();
            this._unwatchInbox();
            for (const id of this._funnelTimeoutIds)
                GLib.source_remove(id);
            this._funnelTimeoutIds.clear();
            this._cancellable.cancel();
        }

        _stopTimer() {
            if (this._timerId) {
                GLib.source_remove(this._timerId);
                this._timerId = 0;
            }
        }

        _restartTimer() {
            this._stopTimer();
            this._timerId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                this._snapshot.installed ? this._pollSeconds : MISSING_POLL_SECONDS,
                () => {
                    // The light poll: status and prefs only. See refresh().
                    if (!this._inflight)
                        this.refresh({ full: false }).catch(() => {});
                    return GLib.SOURCE_CONTINUE;
                },
            );
        }

        // Every line-reader in this file watches a child through the
        // client's own cancellable, so teardown stops all of them at once.
        _watchLines(stream, onLine) {
            _readLines(stream, this._cancellable, onLine);
        }

        async _run(args) {
            const bin = _bin();
            if (!bin) return spawnFailure(new Error(NOT_INSTALLED_ERR));
            try {
                return await _spawn([bin, ...args], this._cancellable);
            } catch (e) {
                return spawnFailure(e);
            }
        }

        // Privileged variant: wraps the command in `pkexec` so the daemon
        // accepts it even without operator (or when checkprefs is denying
        // operator-set users, a known Tailscale quirk affecting `login`,
        // `logout`, and `set --operator`). What gets elevated is an
        // absolute path in one of spawn.js's root-owned system directories,
        // so the elevated half of the extension runs the same program the
        // unelevated half does instead of whatever pkexec's own root PATH
        // would have turned the bare name into. When there is no such path
        // the command fails here rather than being handed to pkexec: see
        // NOT_ELEVATABLE_ERR.
        async _runPriv(args) {
            const bin = _privBin();
            if (!bin) return spawnFailure(new Error(NOT_ELEVATABLE_ERR));
            try {
                return await _spawn([PKEXEC, bin, ...args], this._cancellable);
            } catch (e) {
                return spawnFailure(e);
            }
        }

        /**
         * Set this Unix user as the daemon's operator (writes the OperatorUser
         * pref). Requires root → routed through pkexec, so the user gets a
         * single polkit password prompt. The pref is per-profile, which means
         * any subsequent `tailscale login` (which creates a new profile) wipes
         * it; callers can re-invoke this method when needed.
         */
        async setOperator() {
            const user = GLib.get_user_name();
            const r = await this._runPriv(['set', `--operator=${user}`]);
            const ok = r.ok && !isAccessDenied(r);
            if (!ok) {
                const msg = (r.stderr || r.stdout).split('\n')[0]?.trim() ||
                    `exit ${r.code}`;
                this.emit('error', `Set operator: ${msg}`);
            } else {
                this.emit('notify-info', `Operator set to ${user}`, Category.ACCOUNT);
            }
            await this.refresh();
            return { ok, message: r.stderr || r.stdout };
        }

        /* --------------------------- read paths --------------------------- */

        async _fetchStatus() {
            const r = await this._run(['status', '--json']);
            if (!r.ok) {
                return { ok: false, json: null, err: r.stderr.trim() || `exit ${r.code}` };
            }
            try {
                return { ok: true, json: JSON.parse(r.stdout), err: null };
            } catch (e) {
                return { ok: false, json: null, err: `bad json: ${e.message}` };
            }
        }

        async _fetchPrefs() {
            // `debug prefs` exists since 1.30+, but treat it as best-effort.
            // Older or sandboxed installs may refuse. We never let a prefs
            // failure tank the whole snapshot.
            const r = await this._run(['debug', 'prefs']);
            if (!r.ok) return null;
            try {
                return JSON.parse(r.stdout);
            } catch {
                return null;
            }
        }

        async _fetchAccounts() {
            const r = await this._run(['switch', '--list']);
            if (!r.ok || isAccessDenied(r)) {
                const denied = isAccessDenied(r);
                // Denied means "no operator", not "no accounts": serve the
                // cached list so switching stays reachable. Other failures
                // (daemon down) genuinely have nothing to offer.
                this._lastAccounts = {
                    accounts: denied ? this._knownAccounts : [], denied,
                };
                return this._lastAccounts;
            }
            this._knownAccounts = parseSwitchList(r.stdout);
            this._lastAccounts = { accounts: this._knownAccounts, denied: false };
            return this._lastAccounts;
        }

        async _fetchFunnels() {
            // `funnel status --json` returns `{}` when no serve config exists.
            // Treat any failure as "no funnels" rather than tanking the snap.
            const r = await this._run(['funnel', 'status', '--json']);
            if (!r.ok) {
                this._lastFunnels = [];
                return this._lastFunnels;
            }
            try {
                this._lastFunnels = parseFunnels(JSON.parse(r.stdout));
            } catch {
                this._lastFunnels = [];
            }
            return this._lastFunnels;
        }

        /**
         * Settle into the no-CLI state: an empty snapshot flagged
         * `installed: false`, the receiver stopped, and the poll slowed
         * down. Idempotent: every poll while the binary is gone lands
         * here, and only the first one changes anything.
         *
         * Nothing is announced from here. The state travels on
         * 'state-changed' like every other fact about the world, and the
         * watcher turns the *transition* into the one notification it
         * deserves, which is also what keeps a machine that simply has no
         * Tailscale from being told so at every login.
         *
         * @returns {Snapshot}
         */
        _goMissing() {
            if (!this._snapshot.installed) return this._snapshot;

            // The receiver is a long-lived child of the very binary that
            // just went away; whatever is left of it cannot receive.
            this._stopReceiver();
            // Nothing the deferred pair last reported can still be true
            // with no binary to have reported it. _knownAccounts survives
            // on purpose: it is what lets the menu offer switching back to
            // a profile once a package is installed again.
            this._lastAccounts = { accounts: [], denied: false };
            this._lastFunnels = [];
            this._snapshot = {
                ...EMPTY_SNAPSHOT, installed: false, error: NOT_INSTALLED_ERR,
            };
            this._restartTimer();
            this.emit('state-changed', this._snapshot);
            return this._snapshot;
        }

        /**
         * Fetch a fresh snapshot and emit 'state-changed' iff it changed.
         * Returns the new snapshot.
         *
         * Two of the four commands behind a snapshot only ever feed rows
         * inside the menu: the profile list (`switch --list`) and the serve
         * config (`funnel status --json`). Neither can be seen while the
         * menu is closed, and neither changes on its own — a profile
         * appears when someone logs in, a funnel when someone publishes one,
         * both through this client. So the timer skips them and the snapshot
         * carries the last full answer forward; everything a closed menu
         * does show (the panel icon, the toggle) comes from the other two,
         * which still run at the user's poll interval.
         *
         * `full` therefore defaults to true: every caller but the timer is
         * either a user action or a moment the user is about to look, and
         * those are exactly when the deferred pair can have changed.
         *
         * @param {{full?: boolean}} [options]
         * @returns {Promise<Snapshot>}
         */
        async refresh({ full = true } = {}) {
            if (this._inflight) {
                // Dropping this one would drop what it asked for: the poll
                // already running fetches two of the four commands, so a
                // full request landing on top of it (a menu opening, a
                // command finishing) has to be honoured once that one is
                // out of the way rather than folded into it.
                if (full) this._pendingFull = true;
                return this._snapshot;
            }
            this._inflight = true;
            try {
                // No CLI: answer from the probe alone and never spawn. Four
                // commands that cannot start would otherwise reject out of
                // Gio.Subprocess.new, land in the catch below and put an
                // error banner on screen on every single poll.
                if (!_binaryPresent())
                    return this._goMissing();
                const wasMissing = !this._snapshot.installed;

                const [status, prefs, accountsResult, funnels] = await Promise.all([
                    this._fetchStatus(),
                    this._fetchPrefs(),
                    full ? this._fetchAccounts() : this._lastAccounts,
                    full ? this._fetchFunnels() : this._lastFunnels,
                ]);
                // Cancelled mid-flight (extension disabled): keep the old
                // snapshot and stay silent instead of emitting from stale,
                // partially-cancelled results.
                if (this._cancellable.is_cancelled()) return this._snapshot;
                const canControl = !accountsResult.denied;
                const accounts = accountsResult.accounts;
                let snap;
                if (!status.ok) {
                    snap = { ...EMPTY_SNAPSHOT, accounts, canControl, funnels, error: status.err };
                } else {
                    snap = buildSnapshot(status.json, prefs, accounts, canControl, funnels);
                }
                // "Don't know" inherits the last real answer. Without this a
                // single unreadable poll would drop Taildrop and Funnel out
                // of the menu and put them back a second later, and would
                // fire a disabled/enabled pair of notifications on the way.
                snap.taildropAvailable ??= this._snapshot.taildropAvailable;
                snap.funnelsAvailable ??= this._snapshot.funnelsAvailable;
                if (!snapshotEqual(snap, this._snapshot)) {
                    this._snapshot = snap;
                    this.emit('state-changed', snap);
                }
                // Back from the slow cadence _goMissing() put us on.
                if (wasMissing) this._restartTimer();
                return snap;
            } catch (e) {
                this.emit('error', String(e.message ?? e));
                return this._snapshot;
            } finally {
                this._inflight = false;
                // Cleared before the re-run so the two cannot bounce off
                // each other; a cancelled client is not worth re-running for.
                if (this._pendingFull) {
                    this._pendingFull = false;
                    if (!this._cancellable.is_cancelled())
                        this.refresh().catch(() => {});
                }
            }
        }

        /* -------------------------- write paths --------------------------- */

        /**
         * Run a state-changing command and refresh afterwards. The Tailscale
         * CLI exits with code 0 even when it printed "Access denied: …" to
         * stderr (typically because OperatorUser is unset on Linux). We treat
         * that wording as failure, regardless of exit code.
         *
         * @returns {Promise<{ok: boolean, message: string, denied: boolean}>}
         */
        async _runAndRefresh(args, { quiet = false } = {}) {
            const r = await this._run(args);
            const denied = isAccessDenied(r);
            const ok = r.ok && !denied;
            if (!ok && !quiet) {
                const msg = (r.stderr || r.stdout).split('\n')[0]?.trim() || `exit ${r.code}`;
                this.emit('error', `tailscale ${args.join(' ')}: ${msg}`);
            }
            // Always refresh: even on failure, the daemon may have moved.
            await this.refresh();
            return {
                ok,
                denied,
                message: ok ? r.stdout.trim() : (r.stderr || r.stdout).trim(),
            };
        }

        up()   { return this._runAndRefresh(['up']); }
        down() { return this._runAndRefresh(['down']); }

        // Logout costs exactly one polkit prompt. It wipes the daemon's
        // OperatorUser pref along with the discarded profile, but we
        // deliberately do NOT chase it with a second elevated
        // `set --operator`: the only useful follow-up is `login`, which
        // restores the pref in its own single prompt (`--operator` flag),
        // and the menu keeps the Login entry reachable while logged out
        // even without operator. (A single-prompt chain would need
        // `sh -c`, which EGO review rejects as a non-literal command.)
        async logout() {
            const r = await this._runPriv(['logout']);
            const denied = isAccessDenied(r);
            const ok = r.ok && !denied;
            if (!ok) {
                const msg = (r.stderr || r.stdout).split('\n')[0]?.trim() ||
                    `exit ${r.code}`;
                if (r.code === 126 || r.code === 127)
                    this.emit('error', 'Logout: admin authentication cancelled');
                else
                    this.emit('error', `tailscale logout: ${msg}`);
            } else {
                // The discarded profile disappears from `switch --list`;
                // mirror that in the cached fallback so the menu doesn't
                // offer a dead entry, and clear the current marker (no
                // profile is active while logged out).
                this._knownAccounts = this._knownAccounts
                    .filter((a) => !a.current)
                    .map((a) => ({ ...a, current: false }));
            }
            await this.refresh();
            return { ok, message: (r.stderr || r.stdout).trim() };
        }

        // Interactive login. Goes through pkexec because Tailscale denies
        // `tailscale login` on operator-set profiles ("checkprefs access
        // denied"), and passes --operator so the new profile keeps the pref.
        // Reads stdout AND stderr (the URL lands on stderr in current
        // versions), opens the browser on the first https:// match, then
        // waits for the child to distinguish: URL+exit0 = logged in,
        // no-URL+exit0 = already authenticated, anything else = failure.
        async login() {
            const user = GLib.get_user_name();
            const bin = _privBin();
            if (!bin) {
                this.emit('error', `Login: ${NOT_ELEVATABLE_ERR}`);
                return { ok: false, message: NOT_ELEVATABLE_ERR };
            }
            let proc;
            try {
                proc = _spawnStreaming([PKEXEC, bin, 'login', `--operator=${user}`]);
            } catch (e) {
                this.emit('error', `Login: failed to spawn (${e.message})`);
                return { ok: false, message: e.message };
            }

            let urlFound = false;

            const tryLaunchUrl = (line) => {
                if (urlFound) return;
                const m = line.match(/https?:\/\/\S+/);
                if (!m) return;
                urlFound = true;
                const url = m[0];
                try {
                    Gio.AppInfo.launch_default_for_uri(url, null);
                } catch (e) {
                    this.emit('error', `Login: could not open browser (${e.message})`);
                }
                this.emit('notify-info', `Login: opened ${url}`, Category.ACCOUNT);
            };

            const outBuf = { text: '' };
            const errBuf = { text: '' };
            // The URL is printed on whichever pipe pkexec leaves it on, so
            // both are watched for it and both are kept for the diagnosis
            // below.
            const collect = (buf) => (line) => {
                buf.text += line + '\n';
                tryLaunchUrl(line);
            };
            this._watchLines(proc.get_stdout_pipe(), collect(outBuf));
            this._watchLines(proc.get_stderr_pipe(), collect(errBuf));

            proc.wait_async(this._cancellable, (p, res) => {
                try {
                    p.wait_finish(res);
                } catch {
                    return;  // cancelled: extension is being disabled
                }
                const code = p.get_exit_status();
                const combined = (errBuf.text + '\n' + outBuf.text).trim();
                const denied = ACCESS_DENIED_RE.test(combined);

                if (denied) {
                    this.emit('error',
                        `Login: access denied. Try: sudo tailscale set --operator=${user}`);
                } else if (code !== 0 && !urlFound) {
                    const firstErr =
                        (errBuf.text || outBuf.text).split('\n').find((l) => l.trim()) ||
                        `exit ${code}`;
                    // pkexec dismissed → exit 126/127. Make the message clearer.
                    if (code === 126 || code === 127)
                        this.emit('error', 'Login: admin authentication cancelled');
                    else
                        this.emit('error', `tailscale login: ${firstErr}`);
                } else if (code !== 0 && urlFound) {
                    // User saw the URL but the daemon-side login flow did
                    // not complete (closed the browser tab, denied access,
                    // server-side error). Don't claim success.
                    this.emit('notify-info', 'Login: authentication did not complete',
                        Category.ACCOUNT);
                } else if (!urlFound && code === 0) {
                    // Silent success: already authenticated, no URL needed.
                    this.emit('notify-info', 'Login: already authenticated', Category.ACCOUNT);
                } else {
                    // urlFound && code === 0: browser flow completed.
                    this.emit('notify-info', 'Logged in to Tailscale', Category.ACCOUNT);
                }
                // Refresh state. The `--operator` flag should have preserved
                // operator-ness for the new profile, so no second prompt
                // needed in the happy path.
                this.refresh().catch(() => {});
            });

            return { ok: true, message: 'login started' };
        }

        async switchAccount(id) {
            if (!id) return { ok: false, message: 'missing account id' };

            // Use _run (not _runAndRefresh) so we emit exactly ONE
            // state-changed at the very end. Intermediate refreshes cause
            // visible blinks in the menu.
            //
            // Without operator (typically right after a logout) the daemon
            // refuses `switch`, so the call elevates: a fixed
            // `pkexec tailscale switch <id>` where the profile id comes
            // from the daemon's own `switch --list` output and is
            // validated as a plain token. Once on the target profile its
            // own OperatorUser pref applies, so control usually returns
            // without any further prompt.
            let sr;
            if (this._snapshot.canControl) {
                sr = await this._run(['switch', id]);
            } else {
                if (!/^[A-Za-z0-9_.-]+$/.test(id))
                    return { ok: false, message: 'invalid account id' };
                sr = await this._runPriv(['switch', id]);
            }
            const denied = isAccessDenied(sr);
            if (!sr.ok || denied) {
                if (sr.code === 126 || sr.code === 127) {
                    this.emit('error', 'Switch: admin authentication cancelled');
                } else if (!denied) {
                    const msg = (sr.stderr || sr.stdout).split('\n')[0]?.trim() ||
                        `exit ${sr.code}`;
                    this.emit('error', `tailscale switch ${id}: ${msg}`);
                }
                await this.refresh();
                return { ok: false, denied, message: (sr.stderr || sr.stdout).trim() };
            }

            // Always connect to the switched-to account. Peek at its state
            // so we know whether `up` is enough or whether the profile
            // needs the interactive login flow. Both fetchers already
            // swallow their own parse errors and report "unknown" as
            // null/false, which lands on the plain `up` path.
            const [status, prefs] = await Promise.all([
                this._fetchStatus(),
                this._fetchPrefs(),
            ]);
            const needsLogin = status.json?.BackendState === 'NeedsLogin';
            const loggedOut = !!prefs?.LoggedOut;

            if (loggedOut || needsLogin) await this.login();
            else await this._run(['up']);

            await this.refresh();
            return { ok: true, denied: false, message: '' };
        }

        setAcceptRoutes(value)   { return this._runAndRefresh(['set', `--accept-routes=${value ? 'true' : 'false'}`]); }
        setAcceptDNS(value)      { return this._runAndRefresh(['set', `--accept-dns=${value ? 'true' : 'false'}`]); }
        setAllowLanAccess(value) { return this._runAndRefresh(['set', `--exit-node-allow-lan-access=${value ? 'true' : 'false'}`]); }
        setShieldsUp(value)      { return this._runAndRefresh(['set', `--shields-up=${value ? 'true' : 'false'}`]); }
        setRunSSH(value)         { return this._runAndRefresh(['set', `--ssh=${value ? 'true' : 'false'}`]); }

        /**
         * @param {string|null} target
         *   - null/empty       → clear exit node
         *   - "auto:any"       → automatic exit node
         *   - peer hostname/IP → that peer
         */
        setExitNode(target) {
            const value = target ?? '';
            return this._runAndRefresh(['set', `--exit-node=${value}`]);
        }

        // Expose a local service to the public internet via Tailscale Funnel.
        // Streams the CLI output instead of waiting for exit because the
        // command blocks indefinitely when Funnel is not yet enabled for the
        // tailnet (it polls the control plane until the admin clicks the
        // approval URL it printed). We detect that URL, surface it, and kill
        // the child so the caller isn't stuck waiting.
        //
        // Resolves with:
        //   { ok: true }              -> funnel set, snapshot will refresh
        //   { notEnabled: true, url } -> open the URL, ask the user to retry
        //   { ok: false, message }    -> first error line
        addFunnel(localTarget, httpsPort = 443) {
            return new Promise((resolve) => {
                // Refuse to silently replace an existing funnel: `funnel
                // --bg` on an occupied port would overwrite its serve
                // config. The Add dialog greys occupied ports out already;
                // this is the backstop for a stale snapshot.
                if (this._snapshot.funnels.some((f) => f.httpsPort === httpsPort)) {
                    resolve({
                        ok: false,
                        message: `Port ${httpsPort} already has a funnel, remove it first.`,
                    });
                    return;
                }
                const bin = _bin();
                if (!bin) {
                    resolve({ ok: false, message: NOT_INSTALLED_ERR });
                    return;
                }
                let proc;
                try {
                    proc = _spawnStreaming([
                        bin, 'funnel', '--bg', '--yes',
                        `--https=${httpsPort}`, String(localTarget),
                    ]);
                } catch (e) {
                    resolve({ ok: false, message: e.message });
                    return;
                }

                let outBuf = '';
                let errBuf = '';
                let resolved = false;   // single-shot latch for the promise
                let sawNotEnabled = false;
                let timeoutId = 0;

                const finish = (r) => {
                    if (resolved) return;
                    resolved = true;
                    if (this._funnelTimeoutIds.has(timeoutId)) {
                        GLib.source_remove(timeoutId);
                        this._funnelTimeoutIds.delete(timeoutId);
                    }
                    proc.force_exit();
                    this.refresh().catch(() => {});
                    resolve(r);
                };

                // The not-enabled notice and the approval URL that follows it
                // arrive on the same pipe, so the reader stops itself the
                // moment it has the pair: nothing after that is wanted.
                const collect = (isErr) => (line) => {
                    if (isErr) errBuf += line + '\n';
                    else       outBuf += line + '\n';
                    if (/funnel is not enabled/i.test(line))
                        sawNotEnabled = true;
                    if (!sawNotEnabled) return;
                    const m = line.match(/https?:\/\/\S+/);
                    if (!m) return;
                    finish({ notEnabled: true, url: m[0] });
                    return false;
                };
                this._watchLines(proc.get_stdout_pipe(), collect(false));
                this._watchLines(proc.get_stderr_pipe(), collect(true));

                proc.wait_async(this._cancellable, (p, res) => {
                    try {
                        p.wait_finish(res);
                    } catch {
                        return;  // cancelled: extension is being disabled
                    }
                    if (resolved) return;
                    const code = p.get_exit_status();
                    const combined = (errBuf + '\n' + outBuf).trim();
                    if (/access denied/i.test(combined))
                        finish({ ok: false, message: 'Access denied. Operator may not be set.' });
                    else if (code !== 0) {
                        const first = (errBuf || outBuf).split('\n').find((l) => l.trim()) ||
                            `exit ${code}`;
                        finish({ ok: false, message: first });
                    } else {
                        finish({ ok: true });
                    }
                });

                // Watchdog: registered so destroy() can remove it, removed
                // by finish() as soon as any other outcome lands first.
                timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
                    this._funnelTimeoutIds.delete(timeoutId);
                    finish({ ok: false, message: 'Funnel command timed out.' });
                    return GLib.SOURCE_REMOVE;
                });
                this._funnelTimeoutIds.add(timeoutId);
            });
        }

        /** Disable the funnel on a specific HTTPS port. */
        async removeFunnel(httpsPort = 443) {
            const r = await this._runAndRefresh([
                'funnel', `--https=${httpsPort}`, 'off',
            ]);
            if (r.ok) this.emit('notify-info', 'Funnel removed', Category.FUNNEL);
            return r;
        }

        /* ----------------------------- Taildrop -------------------------- */

        /**
         * Start or stop a long-running `tailscale file get --loop` so
         * inbound Taildrop files land in the inbox directory. The child
         * process is owned by the client and killed on destroy().
         */
        setAcceptFiles(enabled, inbox) {
            if (enabled) this._startReceiver(inbox);
            else this._stopReceiver();
        }

        _resolveInbox(inbox) {
            if (inbox && inbox.length > 0) return inbox;
            return GLib.build_filenamev([GLib.get_home_dir(), 'Downloads', 'Taildrop']);
        }

        _ensureDir(path) {
            try {
                Gio.File.new_for_path(path).make_directory_with_parents(null);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
                    throw e;
            }
        }

        _startReceiver(inbox) {
            if (this._receiver) return;
            // Reached from enable() before the first poll has run, off a
            // setting that persists across sessions. Without the CLI there
            // is nothing to start, and the try/catch below would turn a
            // login on a machine that has no Tailscale into an error banner.
            if (!this._snapshot.installed) return;
            const dir = this._resolveInbox(inbox);
            try {
                this._ensureDir(dir);
            } catch (e) {
                this.emit('error', `Taildrop: cannot create inbox (${e.message})`);
                return;
            }
            this._watchInbox(dir);

            const bin = _bin();
            if (!bin) return;   // nothing to receive with; see snapshot.installed
            let proc;
            try {
                proc = _spawnStreaming([
                    bin, 'file', 'get', '--loop', '--conflict=rename', '--verbose', dir,
                ]);
            } catch (e) {
                this.emit('error', `Taildrop receiver: ${e.message}`);
                return;
            }
            this._receiver = proc;
            this._receiverInbox = dir;

            // Surface inbound files. The only verbose line that carries one
            // is "wrote … as <path> (<n> bytes)"; see parseWroteLine. The
            // sender is deliberately not reported: `tailscale file get` never
            // prints it, and the LocalAPI record behind the command
            // (apitype.WaitingFile) holds nothing but a name and a size, so
            // there is no peer to name.
            const onLine = (line) => {
                const got = parseWroteLine(line);
                if (got) this.emit('file-received', got.path, got.size);
            };
            this._watchLines(proc.get_stdout_pipe(), onLine);
            this._watchLines(proc.get_stderr_pipe(), onLine);

            proc.wait_async(this._cancellable, (p, res) => {
                try {
                    p.wait_finish(res);
                } catch {
                    return;  // cancelled: extension is being disabled
                }
                if (this._receiver !== p) return; // we replaced/stopped it
                const code = p.get_exit_status();
                this._receiver = null;
                if (code !== 0) {
                    this.emit('error', `Taildrop receiver exited (code ${code})`);
                    // Auto-restart so a deleted inbox folder gets re-created
                    // on next file arrival. Clear first: a receiver respawned
                    // while an earlier restart is still pending would overwrite
                    // the id and orphan that source, leaving it to fire after
                    // destroy(). _stopReceiver removes whatever is left, and
                    // both user toggle-off and destroy land there.
                    this._clearReceiverRestart();
                    this._receiverRestartId = GLib.timeout_add_seconds(
                        GLib.PRIORITY_DEFAULT, 3, () => {
                            this._receiverRestartId = 0;
                            this._startReceiver(this._receiverInbox);
                            return GLib.SOURCE_REMOVE;
                        });
                }
            });
        }

        _clearReceiverRestart() {
            if (this._receiverRestartId) {
                GLib.source_remove(this._receiverRestartId);
                this._receiverRestartId = 0;
            }
        }

        _stopReceiver() {
            this._clearReceiverRestart();
            this._unwatchInbox();
            if (!this._receiver) return;
            const proc = this._receiver;
            this._receiver = null;
            proc.force_exit();
        }

        // Watch the inbox's parent for deletion of the inbox itself.
        // `tailscale file get --loop` does NOT exit when its target dir
        // disappears: it just keeps failing silently. Recreating the
        // directory the moment it's removed lets the next poll succeed
        // without needing a receiver bounce.
        _watchInbox(dir) {
            this._unwatchInbox();
            const file = Gio.File.new_for_path(dir);
            const parent = file.get_parent();
            if (!parent) return;
            const basename = GLib.path_get_basename(dir);
            try {
                this._inboxMonitor = parent.monitor_directory(
                    Gio.FileMonitorFlags.WATCH_MOVES, null);
            } catch {
                return;  // monitoring is best-effort
            }
            this._inboxMonitorId = this._inboxMonitor.connect(
                'changed', (_m, f, _other, event) => {
                    if (f.get_basename() !== basename) return;
                    if (event !== Gio.FileMonitorEvent.DELETED &&
                        event !== Gio.FileMonitorEvent.MOVED_OUT) return;
                    if (file.query_exists(null)) return;
                    try {
                        this._ensureDir(dir);
                    } catch {
                        // Surfaced later via the receiver error path.
                    }
                });
        }

        _unwatchInbox() {
            if (this._inboxMonitor) {
                this._inboxMonitor.disconnect(this._inboxMonitorId);
                this._inboxMonitor.cancel();
            }
            this._inboxMonitor = null;
            this._inboxMonitorId = 0;
        }

        // List Taildrop targets. `tailscale file cp --targets` only LISTS
        // the peers eligible to receive files (one `<IP>\t<hostname>` per
        // line); despite the subcommand's name, nothing is copied. The
        // status column is present (containing "offline; ...") only for
        // unreachable peers.
        //
        // Returns { targets, denied }. `denied` separates "no peers around"
        // from "this tailnet's ACL blocks Taildrop entirely" so the menu can
        // surface a useful error instead of "no online peers".
        async fileTargets() {
            const r = await this._run(['file', 'cp', '--targets']);
            if (!r.ok) {
                const combined = `${r.stderr || ''}\n${r.stdout || ''}`;
                const featureBlocked =
                    /taildrop|file sharing|filesharing/i.test(combined) &&
                    /disabled|not enabled|not allowed|forbidden|no access|does not have/i.test(combined);
                const denied = isAccessDenied(r) || featureBlocked;
                return { targets: [], denied };
            }
            const out = [];
            for (const raw of r.stdout.split('\n')) {
                const t = raw.trim();
                if (!t) continue;
                const cols = t.split('\t');
                const ip = cols[0]?.trim();
                if (!ip) continue;
                out.push({
                    ip,
                    host:    cols[1]?.trim() || ip,
                    offline: /offline/i.test(cols[2] || ''),
                });
            }
            return { targets: out, denied: false };
        }

        /**
         * Send one or more local files to a target peer via Taildrop:
         * `tailscale file cp` is the CLI's network-transfer subcommand,
         * not a filesystem copy. `target` is a hostname / DNS name / IP
         * (without the trailing colon; we add it).
         */
        async sendFile(target, files) {
            if (!target || !files || files.length === 0)
                return { ok: false, message: 'missing target or files' };
            const r = await this._run(['file', 'cp', ...files, `${target}:`]);
            const denied = isAccessDenied(r);
            const ok = r.ok && !denied;
            if (!ok) {
                const msg = (r.stderr || r.stdout).split('\n').find((l) => l.trim()) ||
                    `exit ${r.code}`;
                this.emit('error', `Taildrop send: ${msg}`);
            } else {
                const base = files[0].split('/').pop();
                const note = files.length === 1
                    ? `Sent ${base} to ${target}`
                    : `Sent ${files.length} files to ${target}`;
                this.emit('notify-info', note, Category.TAILDROP);
            }
            return { ok, message: (r.stderr || r.stdout).trim() };
        }
    },
);
