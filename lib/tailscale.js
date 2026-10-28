// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// TailscaleClient: reads the daemon's state and emits 'state-changed' when
// its parsed snapshot mutates. Reads go to tailscaled's LocalAPI socket
// first (localapi.js), which costs no process at all, and are refreshed
// when the daemon's IPN bus says something moved rather than on a fast
// timer; the CLI's `status --json` and friends are the fallback for a
// daemon the socket cannot reach. Every command goes through spawn.js, the
// extension's only launch site, so the main loop never blocks and every
// command it can run is listed in one place.
//
// Privileged operations: on Linux the Tailscale daemon only accepts
// state-changing commands from root or from the Unix user named in its
// OperatorUser pref. Four entry points below (setOperator, logout, login,
// switchAccount) therefore run through `pkexec`, and each one writes its
// whole command out where it runs it:
//
//   ['pkexec', '/usr/bin/env', 'TS_BE_CLI=1', tailscale, 'logout']
//
// The only part not spelled out is `tailscale`, the directory the CLI came
// from: privilegedTailscaleBin() in spawn.js resolves it and always checks
// it against a fixed list of root-owned system directories, never taking
// it on trust from $PATH and never from a setting. A Tailscale found
// anywhere else is run unelevated only; the privileged entry points refuse
// rather than hand it to pkexec. Why `env TS_BE_CLI=1` sits in front of
// the CLI is explained above _runPrivileged(). Every privileged command is
// listed verbatim in README.md under "Privileged operations".

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

// Nothing in this file starts a process itself: spawn.js is the only
// launch site in the extension, and it also holds the binary lookup so the
// preferences process gets the same answers this one does.
import {
    TAILSCALE_BIN as BIN, hasTailscaleCli as _binaryPresent,
    tailscaleBin, privilegedTailscaleBin,
    spawn, spawnStreaming, readLines as _readLines,
} from './spawn.js';
import {
    socketPath as _socketPath, get as _apiGet, watch as _apiWatch,
} from './localapi.js';
import { Category } from './notify-policy.js';
import { taildropInboxDefault } from './util.js';
import {
    EMPTY_SNAPSHOT, ACCESS_DENIED_RE, isAccessDenied, spawnFailure,
    accountsFromProfiles, buildSnapshot, busMessageMatters, funnelMount,
    parseServeConfig, parseSwitchList, serveClash, parseWroteLine,
    snapshotEqual,
} from './tailscale-parse.js';

// Poll cadence while the CLI is missing. Nothing observable can change
// until a package manager runs, so the 1–60s the user picked for live
// status would be a PATH walk every few seconds for the whole session.
const MISSING_POLL_SECONDS = 30;

// The IPN bus: the stream tailscaled pushes a message down whenever its
// state, prefs, own node or peers change, which is what `tailscale debug
// watch-ipn` prints. Holding it open is what lets the timer stand down.
//
// The mask asks for an immediate first message (InitialState, 1<<1), which
// is what proves the stream live, and for peer changes (PeerChanges 1<<12,
// PeerPatches 1<<15): since 1.9x the daemon no longer pushes the network
// map on its own, so without these a peer going offline would never reach
// the bus. Daemons older than those two bits push the whole map instead
// and ignore bits they do not know. Bits 3 and 8 are left out on purpose:
// current daemons refuse a subscription that sets either.
const IPN_BUS_PATH = '/localapi/v0/watch-ipn-bus?mask=' +
    ((1 << 1) | (1 << 12) | (1 << 15));

// While the bus is live the timer is only a safety net, for whatever the
// bus might not carry. Nothing on screen depends on it: every field the
// snapshot compares travels on the bus.
const WATCHED_POLL_SECONDS = 60;

// How long a `tailscale funnel` or `tailscale serve` gets to come back.
// Either one blocks for good when the feature is not enabled for the
// tailnet and nothing on its output says so; see _publish().
const PUBLISH_TIMEOUT_SECONDS = 10;

// One bus message rarely comes alone (a prefs change, then the state
// change it causes, then the peers it re-announces), so they are folded
// into a single read of the state behind them.
const BUS_SETTLE_MS = 250;

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

// An elevated command that comes back unhappy has exactly one way to say
// so today: a notification. That is not enough to work out what happened
// on a machine that is not ours. The banner carries one line, the shell
// can fail to draw it at all (GNOME's own message-stacking code throws on
// the urgency change that a failure triggers), and either way nothing is
// left behind afterwards. So every elevated failure is written to the
// journal in full as well.
//
// pkexec's own journal line is not a substitute. It logs the argument
// vector it was handed, then calls realpath() on the program and execs
// *that*, argv[0] untouched, so on a distribution assembled out of
// symlinked profiles the line names one file while the machine runs
// another. What the command printed is the only account of what actually
// ran.
function _logPrivFailure(argv, r) {
    const detail = (r.stderr || r.stdout).trim() || '(no output)';
    console.warn(
        `tailscale-gnome: ${argv.join(' ')} ` +
        `failed (exit ${r.code}): ${detail}`);
}

/**
 * The arguments, after `tailscale`, that share one service: on the
 * internet with Funnel, within the tailnet with Serve. Exported for the
 * tests.
 *
 * One line per kind, so each command reads as it runs. `--bg` returns as
 * soon as the entry is in the serve config, `--yes` answers the CLI's own
 * confirmation prompt. A web entry takes a mount (`--set-path`, left out
 * for the root, which is the CLI's default); a TCP one an optional PROXY
 * protocol version instead.
 *
 * @param {{kind?: string, httpsPort: number, target: string|number,
 *          path?: string, proxyProtocol?: number}} spec
 * @param {{funnel?: boolean}} [opts]
 * @returns {string[]}
 */
export function serveArgs(spec, { funnel = false } = {}) {
    const command = funnel ? 'funnel' : 'serve';
    const port = spec.httpsPort;
    const target = String(spec.target);
    const mount = funnelMount(spec.path);
    const setPath = mount === '/' ? [] : [`--set-path=${mount}`];
    const proxy = spec.proxyProtocol
        ? [`--proxy-protocol=${spec.proxyProtocol}`] : [];
    switch (spec.kind ?? 'https') {
    case 'https':
        return [command, '--bg', '--yes', `--https=${port}`, ...setPath, target];
    case 'http':
        return [command, '--bg', '--yes', `--http=${port}`, ...setPath, target];
    case 'tcp':
        return [command, '--bg', '--yes', `--tcp=${port}`, ...proxy, target];
    case 'tls-tcp':
        return [command, '--bg', '--yes', `--tls-terminated-tcp=${port}`, ...proxy, target];
    default:
        throw new Error(`unknown ${command} kind: ${spec.kind}`);
    }
}

/**
 * The arguments, after `tailscale`, that take exactly one entry down.
 * Exported for the tests.
 *
 * A web entry is named by its mount as well as its port: without
 * --set-path the CLI removes every mount on the port at once. An entry of
 * a kind this file does not know is taken for HTTPS, the CLI's default.
 *
 * @param {{kind?: string, httpsPort: number, path?: string}} entry a
 *   snapshot entry
 * @param {{funnel?: boolean}} [opts]
 * @returns {string[]}
 */
export function serveOffArgs(entry, { funnel = false } = {}) {
    const command = funnel ? 'funnel' : 'serve';
    const port = entry.httpsPort;
    const mount = funnelMount(entry.path);
    switch (entry.kind) {
    case 'http':
        return [command, `--http=${port}`, `--set-path=${mount}`, 'off'];
    case 'tcp':
        return [command, `--tcp=${port}`, 'off'];
    case 'tls-tcp':
        return [command, `--tls-terminated-tcp=${port}`, 'off'];
    default:
        return [command, `--https=${port}`, `--set-path=${mount}`, 'off'];
    }
}

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
            // Every main-loop source this client owns, each in a property
            // of its own and each removed by name in destroy():
            //   _timerId            the poll timer, _restartTimer()
            //   _busSettleId        folds bus messages, _busActivity()
            //   _receiverRestartId  Taildrop receiver restart, _startReceiver()
            //   _publishTimeoutId   serve/funnel watchdog, _publish()
            this._timerId = 0;
            this._busSettleId = 0;
            this._receiverRestartId = 0;
            this._publishTimeoutId = 0;
            this._inflight = false;
            // A full refresh asked for while a light one was running; see
            // refresh().
            this._pendingFull = false;
            // The `tailscale funnel|serve` command in flight, if any; see
            // _publish(). One at a time.
            this._publishProc = null;
            this._receiver = null;
            this._receiverInbox = null;
            this._inboxMonitor = null;
            this._inboxMonitorId = 0;
            // Last successful `switch --list` result. Served as a fallback
            // while the daemon denies the listing (no operator, typically
            // right after a logout) so the menu can keep offering account
            // switching: the switch itself elevates in that state.
            this._knownAccounts = [];
            // What the last full refresh learned from the two commands the
            // timer no longer runs; see refresh().
            this._lastAccounts = { accounts: [], denied: false };
            this._lastFunnels = [];
            this._lastServes = [];
            // The open IPN bus subscription, if any; see _startWatch().
            this._watch = null;
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
            this._startWatch();
            this._restartTimer();
            // Kick off an immediate refresh so the UI never starts blank.
            this.refresh().catch(() => {});
        }

        /** Stop polling, kill owned subprocesses and cancel anything in flight. */
        destroy() {
            this._pendingFull = false;

            // The four main-loop sources listed in _init(), removed here
            // rather than through the helpers that also stop them, so the
            // whole of the cleanup reads in one place.
            if (this._timerId) {
                GLib.source_remove(this._timerId);
                this._timerId = 0;
            }
            if (this._busSettleId) {
                GLib.source_remove(this._busSettleId);
                this._busSettleId = 0;
            }
            if (this._receiverRestartId) {
                GLib.source_remove(this._receiverRestartId);
                this._receiverRestartId = 0;
            }
            if (this._publishTimeoutId) {
                GLib.source_remove(this._publishTimeoutId);
                this._publishTimeoutId = 0;
            }

            // The children: the Taildrop receiver and a serve/funnel
            // command still waiting on its tailnet.
            this._stopWatch();
            this._stopReceiver();
            this._publishProc?.force_exit();
            this._publishProc = null;

            // Whatever else is in flight (one-shot commands, LocalAPI
            // reads, the line readers) runs on this cancellable.
            this._cancellable.cancel();
        }

        _stopTimer() {
            if (this._timerId) {
                GLib.source_remove(this._timerId);
                this._timerId = 0;
            }
        }

        // The user's interval only applies while nothing better is telling
        // us when to look: with the bus live, the daemon says so itself.
        _timerSeconds() {
            if (!this._snapshot.installed) return MISSING_POLL_SECONDS;
            if (this._watch?.live)
                return Math.max(this._pollSeconds, WATCHED_POLL_SECONDS);
            return this._pollSeconds;
        }

        _restartTimer() {
            this._stopTimer();
            this._timerId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                this._timerSeconds(),
                () => {
                    // A daemon restarted under us dropped the bus; each tick
                    // without one is a chance to get it back, at the cost of
                    // a connect() to a socket that may not be listening.
                    this._startWatch();
                    // The light poll: status and prefs only. See refresh().
                    if (!this._inflight)
                        this.refresh({ full: false }).catch(() => {});
                    return GLib.SOURCE_CONTINUE;
                },
            );
        }

        /* --------------------------- IPN bus ----------------------------- */

        /**
         * Subscribe to the daemon's IPN bus, if it can be reached and we are
         * not subscribed already. Idempotent.
         *
         * While the subscription is live the timer drops to a safety-net
         * cadence and every refresh is one the daemon asked for, so an idle
         * tailnet costs nothing at all and a change shows up within
         * BUS_SETTLE_MS instead of up to a whole poll interval later. When
         * it drops (daemon restarted, stopped, upgraded) the user's own
         * interval comes back until the next tick reconnects.
         */
        _startWatch() {
            if (this._watch || this._cancellable.is_cancelled()) return;
            if (!this._snapshot.installed) return;
            const socket = _socketPath();
            if (!socket) return;
            const handle = { live: false, stop: null };
            this._watch = handle;
            handle.stop = _apiWatch(socket, IPN_BUS_PATH, this._cancellable, {
                onOpen: () => {
                    handle.live = true;
                    this._restartTimer();
                },
                // Most of what a large tailnet says on the bus is peers
                // roaming and re-handshaking, none of which is on screen;
                // see busMessageMatters().
                onMessage: (text) => {
                    if (busMessageMatters(text)) this._busActivity();
                },
                onClose: (opened) => {
                    if (this._watch !== handle) return;
                    this._watch = null;
                    if (!opened) return;
                    // Whatever went away took state with it: read it now
                    // rather than at the next tick, and go back to the
                    // user's cadence until the bus returns.
                    this._restartTimer();
                    this._busActivity();
                },
            }).stop;
        }

        _stopWatch() {
            if (this._busSettleId) {
                GLib.source_remove(this._busSettleId);
                this._busSettleId = 0;
            }
            const handle = this._watch;
            this._watch = null;
            handle?.stop();
        }

        _busActivity() {
            if (this._busSettleId) return;
            this._busSettleId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, BUS_SETTLE_MS, () => {
                    // A refresh already running may have read the state
                    // before this message's change landed. Wait it out
                    // rather than drop the request: the bus will not say
                    // it twice.
                    if (this._inflight) return GLib.SOURCE_CONTINUE;
                    this._busSettleId = 0;
                    this.refresh({ full: false }).catch(() => {});
                    return GLib.SOURCE_REMOVE;
                });
        }

        // Every line-reader in this file watches a child through the
        // client's own cancellable, so teardown stops all of them at once.
        _watchLines(stream, onLine) {
            _readLines(stream, this._cancellable, onLine);
        }

        // Runs `tailscale <args>`, unprivileged: `this._run(['up'])` is
        // `tailscale up`. Every unprivileged one-shot command in this file
        // goes through here, with its arguments written out at the call.
        async _run(args) {
            const tailscale = tailscaleBin();
            if (!tailscale) return spawnFailure(new Error(NOT_INSTALLED_ERR));
            try {
                return await spawn([tailscale, ...args], this._cancellable);
            } catch (e) {
                return spawnFailure(e);
            }
        }

        // What a privileged entry point returns when there is no Tailscale
        // it is willing to elevate; see NOT_ELEVATABLE_ERR.
        _notElevatable() {
            return spawnFailure(new Error(NOT_ELEVATABLE_ERR));
        }

        // Runs one of the privileged commands, which every caller writes
        // out whole:
        //
        //   ['pkexec', '/usr/bin/env', 'TS_BE_CLI=1', tailscale, ...]
        //
        // `pkexec` so the daemon accepts it even without operator (or when
        // checkprefs is denying operator-set users, a known Tailscale quirk
        // affecting `login`, `logout`, and `set --operator`). `tailscale`
        // is privilegedTailscaleBin(): an absolute path in one of spawn.js's
        // root-owned system directories, so the elevated half of the
        // extension runs the same program the unelevated half does instead
        // of whatever pkexec's own root PATH would have turned the bare
        // name into. When there is no such path the caller never gets here:
        // see _notElevatable().
        //
        // `/usr/bin/env TS_BE_CLI=1` looks like it should not be needed,
        // and on most distributions it is not. It is on NixOS, and the
        // reason is worth spelling out because the failure is silent and
        // looks like ours. There, `bin/tailscale` is a symlink to
        // `bin/tailscaled`: one combined binary that decides which half of
        // itself to be from argv[0], and `bin/tailscaled` is in turn a `#!`
        // wrapper script. polkit 127 added a realpath() on the program
        // before exec'ing it. It takes care to leave argv[0] alone, but the
        // shebang undoes that: for a script the kernel discards the
        // caller's argv[0] and puts the exec'd path there instead. So the
        // CLI we asked for starts as the daemon and answers
        //
        //   tailscaled does not take non-flag arguments: ["set" "--operator=…"]
        //
        // TS_BE_CLI is Tailscale's own override for exactly this. pkexec
        // wipes the environment, so the only way to hand a variable to the
        // elevated process is to make `env` the program it runs, which also
        // sidesteps the realpath: env execs the path it is given, symlink
        // and all. env is not a shell, and /usr/bin/env is one of the two
        // FHS paths every distribution keeps, NixOS included (its
        // activation script links it to coreutils).
        async _runPrivileged(argv) {
            try {
                const r = await spawn(argv, this._cancellable);
                // Teardown cancels in flight commands by design; that is
                // not a failure and has nothing to report.
                if (!r.cancelled && (!r.ok || isAccessDenied(r)))
                    _logPrivFailure(argv, r);
                return r;
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
            const tailscale = privilegedTailscaleBin();
            const r = tailscale
                ? await this._runPrivileged(
                    ['pkexec', '/usr/bin/env', 'TS_BE_CLI=1', tailscale, 'set', `--operator=${user}`])
                : this._notElevatable();
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

        /**
         * GET a LocalAPI path: its status, and the parsed body when that
         * status is 200. Null when there is no answer to speak of: no
         * socket, nobody listening, a 200 whose body is not JSON. Every
         * caller then asks the CLI the same question, which is what keeps
         * the error a broken daemon shows identical to what it was when
         * the CLI was the only way in.
         *
         * @param {string} path
         * @returns {Promise<{status: number, json?: any}|null>}
         */
        async _localApiJson(path) {
            const socket = _socketPath();
            if (!socket) return null;
            try {
                const r = await _apiGet(socket, path, this._cancellable);
                if (r.status !== 200) return { status: r.status };
                return { status: 200, json: JSON.parse(r.body) };
            } catch {
                return null;
            }
        }

        async _fetchStatus() {
            const api = await this._localApiJson('/localapi/v0/status');
            if (api?.status === 200) return { ok: true, json: api.json, err: null };
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
            const api = await this._localApiJson('/localapi/v0/prefs');
            if (api?.status === 200) return api.json;
            const r = await this._run(['debug', 'prefs']);
            if (!r.ok) return null;
            try {
                return JSON.parse(r.stdout);
            } catch {
                return null;
            }
        }

        async _fetchAccounts() {
            const [current, all] = await Promise.all([
                this._localApiJson('/localapi/v0/profiles/current'),
                this._localApiJson('/localapi/v0/profiles/'),
            ]);
            if (current?.status === 200 && all?.status === 200)
                return this._gotAccounts(accountsFromProfiles(current.json, all.json));
            // The daemon lists profiles to root and its operator only, and
            // tells everyone else so with a 403: the same refusal that comes
            // back from the CLI as "Access denied", minus the process.
            if (current?.status === 403 || all?.status === 403)
                return this._accountsFailed(true);

            const r = await this._run(['switch', '--list']);
            if (!r.ok || isAccessDenied(r))
                return this._accountsFailed(isAccessDenied(r));
            return this._gotAccounts(parseSwitchList(r.stdout));
        }

        _gotAccounts(accounts) {
            this._knownAccounts = accounts;
            this._lastAccounts = { accounts, denied: false };
            return this._lastAccounts;
        }

        _accountsFailed(denied) {
            // Denied means "no operator", not "no accounts": serve the
            // cached list so switching stays reachable. Other failures
            // (daemon down) genuinely have nothing to offer.
            this._lastAccounts = {
                accounts: denied ? this._knownAccounts : [], denied,
            };
            return this._lastAccounts;
        }

        // The serve config, split into what Funnel publishes and what Serve
        // shares within the tailnet. One document holds both; see
        // parseServeConfig().
        async _fetchServeConfig() {
            // `serve status --json` returns `{}` when no serve config
            // exists. Treat any failure as "nothing published" rather than
            // tanking the snap. The command prints the config verbatim,
            // `null` for none, so the LocalAPI answer goes through the same
            // parser.
            let entries = [];
            const api = await this._localApiJson('/localapi/v0/serve-config');
            if (api?.status === 200) {
                entries = parseServeConfig(api.json);
            } else {
                const r = await this._run(['funnel', 'status', '--json']);
                try {
                    if (r.ok) entries = parseServeConfig(JSON.parse(r.stdout));
                } catch {
                    entries = [];
                }
            }
            this._lastFunnels = entries.filter((e) => e.public);
            this._lastServes = entries.filter((e) => !e.public);
            return { funnels: this._lastFunnels, serves: this._lastServes };
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
            // Nor is there anything left to drive with what the bus says.
            this._stopWatch();
            // Nothing the deferred pair last reported can still be true
            // with no binary to have reported it. _knownAccounts survives
            // on purpose: it is what lets the menu offer switching back to
            // a profile once a package is installed again.
            this._lastAccounts = { accounts: [], denied: false };
            this._lastFunnels = [];
            this._lastServes = [];
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

                const [status, prefs, accountsResult, served] = await Promise.all([
                    this._fetchStatus(),
                    this._fetchPrefs(),
                    full ? this._fetchAccounts() : this._lastAccounts,
                    full ? this._fetchServeConfig()
                        : { funnels: this._lastFunnels, serves: this._lastServes },
                ]);
                const { funnels, serves } = served;
                // Cancelled mid-flight (extension disabled): keep the old
                // snapshot and stay silent instead of emitting from stale,
                // partially-cancelled results.
                if (this._cancellable.is_cancelled()) return this._snapshot;
                const canControl = !accountsResult.denied;
                const accounts = accountsResult.accounts;
                let snap;
                if (!status.ok) {
                    snap = {
                        ...EMPTY_SNAPSHOT, accounts, canControl, funnels, serves,
                        error: status.err,
                    };
                } else {
                    snap = buildSnapshot(
                        status.json, prefs, accounts, canControl, funnels, serves);
                }
                // "Don't know" inherits the last real answer. Without this a
                // single unreadable poll would drop Taildrop and Funnel out
                // of the menu and put them back a second later, and would
                // fire a disabled/enabled pair of notifications on the way.
                snap.taildropAvailable ??= this._snapshot.taildropAvailable;
                snap.funnelsAvailable ??= this._snapshot.funnelsAvailable;
                snap.httpsAvailable ??= this._snapshot.httpsAvailable;
                if (!snapshotEqual(snap, this._snapshot)) {
                    this._snapshot = snap;
                    this.emit('state-changed', snap);
                }
                // Back from the slow cadence _goMissing() put us on.
                if (wasMissing) {
                    this._startWatch();
                    this._restartTimer();
                }
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
            const tailscale = privilegedTailscaleBin();
            const r = tailscale
                ? await this._runPrivileged(
                    ['pkexec', '/usr/bin/env', 'TS_BE_CLI=1', tailscale, 'logout'])
                : this._notElevatable();
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
            const tailscale = privilegedTailscaleBin();
            if (!tailscale) {
                this.emit('error', `Login: ${NOT_ELEVATABLE_ERR}`);
                return { ok: false, message: NOT_ELEVATABLE_ERR };
            }
            // Same privileged form as the others; see _runPrivileged().
            let proc;
            try {
                proc = spawnStreaming(
                    ['pkexec', '/usr/bin/env', 'TS_BE_CLI=1', tailscale, 'login', `--operator=${user}`]);
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
            // refuses `switch`, so the call elevates: the fixed privileged
            // form ending in `switch <id>`, where the profile id comes
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
                const tailscale = privilegedTailscaleBin();
                sr = tailscale
                    ? await this._runPrivileged(
                        ['pkexec', '/usr/bin/env', 'TS_BE_CLI=1', tailscale, 'switch', id])
                    : this._notElevatable();
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

        // Share a local service: on the internet with Funnel, or within the
        // tailnet with Serve. Both are the same command shape and the same
        // serve config; addFunnel() and addServe() below only pick which.
        //
        // Streams the CLI output instead of waiting for exit because the
        // command blocks indefinitely when the feature is not yet enabled
        // for the tailnet (Funnel itself, or the HTTPS certificates Serve
        // over HTTPS needs): it prints an approval URL and polls the
        // control plane until the admin clicks it. We detect that URL,
        // surface it, and kill the child so the caller isn't stuck waiting.
        //
        // `spec` is what the dialog collects; serveArgs() at the top of
        // this file turns it into the command, one line per kind.
        //
        // Resolves with:
        //   { ok: true }              -> entry set, snapshot will refresh
        //   { notEnabled: true, url } -> open the URL, ask the user to retry
        //   { ok: false, message }    -> first error line
        addFunnel(spec) {
            return this._publish(spec, { funnel: true });
        }

        addServe(spec) {
            return this._publish(spec, { funnel: false });
        }

        // One command at a time, held in this._publishProc, and one
        // watchdog with it, this._publishTimeoutId. _endPublish() and
        // destroy() are the only places either is let go of.
        _publish(spec, { funnel }) {
            return new Promise((resolve) => {
                if (this._publishProc) {
                    resolve({
                        ok: false,
                        message: 'Another Serve or Funnel command is still running.',
                    });
                    return;
                }
                // Refuse to silently replace an existing entry: `--bg` on an
                // occupied port (or mount) would overwrite its serve config,
                // and on a port of the other kind would flip it between the
                // internet and the tailnet. The dialogs grey those out
                // already; this is the backstop for a stale snapshot.
                const all = [...this._snapshot.funnels, ...this._snapshot.serves];
                const clash = serveClash(all, { ...spec, public: funnel });
                if (clash) {
                    let message;
                    if (!!clash.public !== funnel) {
                        message = clash.public
                            ? `Port ${spec.httpsPort} is published with Funnel, remove it first.`
                            : `Port ${spec.httpsPort} is shared with Serve, remove it first.`;
                    } else if (spec.kind === 'https' || spec.kind === 'http') {
                        message = `Port ${spec.httpsPort} already serves this path, remove it first.`;
                    } else {
                        message = `Port ${spec.httpsPort} is already in use, remove it first.`;
                    }
                    resolve({ ok: false, message });
                    return;
                }
                const tailscale = tailscaleBin();
                if (!tailscale) {
                    resolve({ ok: false, message: NOT_INSTALLED_ERR });
                    return;
                }
                let proc;
                try {
                    proc = spawnStreaming([tailscale, ...serveArgs(spec, { funnel })]);
                } catch (e) {
                    resolve({ ok: false, message: e.message });
                    return;
                }
                this._publishProc = proc;

                let outBuf = '';
                let errBuf = '';
                let resolved = false;   // single-shot latch for the promise
                let sawNotEnabled = false;

                const finish = (r) => {
                    if (resolved) return;
                    resolved = true;
                    this._endPublish();
                    this.refresh().catch(() => {});
                    resolve(r);
                };

                // The not-enabled notice and the approval URL that follows it
                // arrive on the same pipe, so the reader stops itself the
                // moment it has the pair: nothing after that is wanted.
                const collect = (isErr) => (line) => {
                    if (isErr) errBuf += line + '\n';
                    else       outBuf += line + '\n';
                    // "Funnel is not enabled on your tailnet", "Serve is
                    // not enabled…": the control plane words the notice,
                    // and the URL that follows is the way to enable it.
                    if (/is not enabled/i.test(line))
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

                // The watchdog. Removed by _endPublish() as soon as any
                // other outcome lands first, and by destroy().
                this._publishTimeoutId = GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT, PUBLISH_TIMEOUT_SECONDS, () => {
                        this._publishTimeoutId = 0;
                        finish({
                            ok: false,
                            message: `${funnel ? 'Funnel' : 'Serve'} command timed out.`,
                        });
                        return GLib.SOURCE_REMOVE;
                    });
            });
        }

        // Let go of the command _publish() started and of its watchdog.
        // The child is killed whatever the outcome: once there is an
        // answer, nothing it could still print is wanted, and a command
        // waiting on its tailnet would otherwise wait for good.
        _endPublish() {
            if (this._publishTimeoutId) {
                GLib.source_remove(this._publishTimeoutId);
                this._publishTimeoutId = 0;
            }
            this._publishProc?.force_exit();
            this._publishProc = null;
        }

        /** Take one published funnel (a snapshot entry) down. */
        async removeFunnel(f) {
            const r = await this._runAndRefresh(serveOffArgs(f, { funnel: true }));
            if (r.ok) this.emit('notify-info', 'Funnel removed', Category.FUNNEL);
            return r;
        }

        /** Stop sharing one tailnet-only entry (a snapshot entry). */
        async removeServe(e) {
            const r = await this._runAndRefresh(serveOffArgs(e, { funnel: false }));
            if (r.ok) this.emit('notify-info', 'Serve entry removed', Category.SERVE);
            return r;
        }

        /**
         * Take every published funnel down, one command each.
         *
         * Not `tailscale funnel reset`: that wipes the whole serve config,
         * tailnet-only `tailscale serve` entries included, which the Funnels
         * dialog neither shows nor owns.
         */
        removeAllFunnels() {
            return this._removeAll(this._snapshot.funnels, true);
        }

        /** The same for Serve, leaving every funnel up. */
        removeAllServes() {
            return this._removeAll(this._snapshot.serves, false);
        }

        // Keeps going past a failure so one stuck entry does not keep the
        // rest up, and reports the first.
        async _removeAll(entries, funnel) {
            let failure = null;
            // A copy: the refreshes other events trigger meanwhile replace
            // the snapshot this loop would otherwise be walking.
            for (const e of [...entries]) {
                const r = await this._run(serveOffArgs(e, { funnel }));
                if ((!r.ok || isAccessDenied(r)) && !failure) failure = r;
            }
            await this.refresh();
            const sub = funnel ? 'funnel' : 'serve';
            if (failure) {
                const msg = (failure.stderr || failure.stdout).split('\n')
                    .find((l) => l.trim()) || `exit ${failure.code}`;
                this.emit('error', `tailscale ${sub} off: ${msg}`);
                return { ok: false, message: msg };
            }
            this.emit('notify-info',
                funnel ? 'Funnels removed' : 'Serve entries removed',
                funnel ? Category.FUNNEL : Category.SERVE);
            return { ok: true, message: '' };
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

        // An empty setting is not "nowhere", it is "wherever the user
        // downloads to". Resolved on every start rather than frozen once,
        // so a machine whose download directory moves is followed rather
        // than left writing into the old one.
        _resolveInbox(inbox) {
            if (inbox && inbox.length > 0) return inbox;
            return taildropInboxDefault();
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

            const tailscale = tailscaleBin();
            if (!tailscale) return;   // nothing to receive with; see snapshot.installed
            let proc;
            try {
                proc = spawnStreaming([
                    tailscale, 'file', 'get', '--loop', '--conflict=rename', '--verbose', dir,
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
