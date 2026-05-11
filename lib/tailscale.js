// Tailscale CLI wrapper. Promise-based, async, polling.
//
// Exposes a TailscaleClient that:
//   • spawns `tailscale` via Gio.Subprocess (no blocking I/O on the main loop)
//   • polls `tailscale status --json` + `tailscale debug prefs` on an interval
//   • emits 'state-changed' whenever the parsed snapshot mutates
//   • exposes one-shot action methods (up / down / set / switch / login /
//     logout / setExitNode) that resolve when the underlying child exits
//
// All paths into gnome-shell go through GObject signals so the menu can stay
// purely reactive. No CLI command runs on the UI thread.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

const DEFAULT_BIN = 'tailscale';

// Decode a Uint8Array stream chunk into a JS string.
const _decoder = new TextDecoder('utf-8');
const _decode = (bytes) => (bytes ? _decoder.decode(bytes) : '');

/**
 * Run a child process asynchronously and resolve with { ok, code, stdout, stderr }.
 * Never throws on non-zero exit. Callers decide how to react.
 */
function _spawn(argv, { cancellable = null, stdinText = null } = {}) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_PIPE |
                    (stdinText !== null ? Gio.SubprocessFlags.STDIN_PIPE : 0),
            );
        } catch (e) {
            reject(e);
            return;
        }

        proc.communicate_utf8_async(stdinText, cancellable, (p, res) => {
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                resolve({
                    ok: p.get_successful(),
                    code: p.get_exit_status(),
                    stdout: stdout ?? '',
                    stderr: stderr ?? '',
                });
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    resolve({ ok: false, code: -1, stdout: '', stderr: 'cancelled', cancelled: true });
                } else {
                    reject(e);
                }
            }
        });
    });
}

/* -------------------------------------------------------------------------- */
/*                              Snapshot model                                */
/* -------------------------------------------------------------------------- */

/**
 * A normalized, UI-friendly view of `tailscale status --json` + prefs.
 *
 * @typedef {object} Peer
 * @property {string}  id              Tailscale peer ID
 * @property {string}  hostname        e.g. "ai-server"
 * @property {string}  dnsName         FQDN within the tailnet
 * @property {string[]} ips            All Tailscale IPs (v4 first)
 * @property {string}  os              "linux" | "android" | "windows" | …
 * @property {boolean} online
 * @property {boolean} active          Currently exchanging traffic
 * @property {boolean} exitNodeOption  Advertises itself as an exit node
 * @property {boolean} exitNode        Is the *currently selected* exit node
 * @property {string[]} tags
 *
 * @typedef {object} Snapshot
 * @property {string}  backendState    e.g. "Running" | "Stopped" | "NeedsLogin" | …
 * @property {boolean} running         backendState === "Running"
 * @property {boolean} loggedOut
 * @property {string}  version         Tailscale daemon version
 * @property {string|null} accountName Display name of the current tailnet user
 * @property {string|null} tailnetName Tailnet/control display name
 * @property {string|null} hostname    Self.HostName
 * @property {string|null} dnsName     Self.DNSName (without trailing dot)
 * @property {string[]} selfIps        Self.TailscaleIPs
 * @property {Peer[]}  peers           All peers, sorted by hostname
 * @property {Peer[]}  exitNodes       Subset advertising exit-node service
 * @property {Peer|null} currentExitNode
 * @property {string[]} health
 * @property {object}  prefs           Raw `tailscale debug prefs` JSON (best-effort)
 * @property {boolean} acceptRoutes
 * @property {boolean} acceptDNS
 * @property {boolean} allowLanAccess
 * @property {boolean} shieldsUp
 * @property {boolean} runSSH
 * @property {string|null} exitNodeID
 * @property {Account[]} accounts
 *
 * @typedef {object} Account
 * @property {string}  id
 * @property {string}  tailnet
 * @property {string}  account
 * @property {boolean} current
 */

const EMPTY_SNAPSHOT = Object.freeze({
    backendState: 'NoState',
    running: false,
    loggedOut: false,
    version: '',
    accountName: null,
    tailnetName: null,
    magicDNSSuffix: null,
    hostname: null,
    dnsName: null,
    selfIps: [],
    peers: [],
    exitNodes: [],
    currentExitNode: null,
    advertisedRoutes: [],   // [{ cidr, peer }, …]
    funnels: [],            // [{ httpsPort, target, host }, …]
    health: [],
    prefs: {},
    acceptRoutes: false,
    acceptDNS: true,
    allowLanAccess: false,
    shieldsUp: false,
    runSSH: false,
    exitNodeID: null,
    autoExitNode: false,    // true when --exit-node=auto:any is active
    accounts: [],
    operatorUser: null,
    canControl: true,    // false when access-denied was observed
    error: null,
});

// Tailscale's CLI is annoying: many failure modes (including the operator-
// is-not-set case) exit with code 0 *and* print "Access denied: …" on stderr.
// We treat any output containing this phrase as a failure regardless of code.
const ACCESS_DENIED_RE = /access denied/i;
function _isAccessDenied(r) {
    return ACCESS_DENIED_RE.test(r.stderr || '') || ACCESS_DENIED_RE.test(r.stdout || '');
}

function _stripDot(s) {
    return s && s.endsWith('.') ? s.slice(0, -1) : s;
}

function _shortHost(dnsName, hostname) {
    if (hostname) return hostname;
    if (!dnsName) return '';
    return _stripDot(dnsName).split('.')[0];
}

// Anything in AllowedIPs that isn't the peer's own /32 (v4) or /128 (v6) is
// a subnet route the peer advertises (and that we'd accept if --accept-routes).
function _advertisedRoutesOf(rawPeer) {
    const own = new Set();
    for (const ip of rawPeer.TailscaleIPs ?? [])
        own.add(ip.includes(':') ? `${ip}/128` : `${ip}/32`);
    return (rawPeer.AllowedIPs ?? []).filter((c) => !own.has(c));
}

function _peersFromStatus(statusJson, prefs) {
    const peers = [];
    const peerMap = statusJson.Peer ?? {};
    const currentExitID = prefs?.ExitNodeID ?? statusJson?.ExitNodeStatus?.ID ?? '';
    for (const key of Object.keys(peerMap)) {
        const p = peerMap[key];
        peers.push({
            id: p.ID ?? key,
            hostname: p.HostName ?? '',
            dnsName: _stripDot(p.DNSName ?? ''),
            ips: Array.isArray(p.TailscaleIPs) ? p.TailscaleIPs : [],
            os: p.OS ?? '',
            online: !!p.Online,
            active: !!p.Active,
            exitNodeOption: !!p.ExitNodeOption,
            exitNode: !!p.ExitNode || (currentExitID && p.ID === currentExitID),
            tags: Array.isArray(p.Tags) ? p.Tags : [],
            advertisedRoutes: _advertisedRoutesOf(p),
        });
    }
    peers.sort((a, b) =>
        (a.hostname || a.dnsName).localeCompare(b.hostname || b.dnsName, undefined, {
            sensitivity: 'base',
        }),
    );
    return peers;
}

// Parse `tailscale funnel status --json` (a ServeConfig). Returns the active
// funnel entries as `[{ httpsPort, target, host }]`. The CLI uses both
// `Funnel` and (older) `AllowFunnel` keys; we accept either.
function _parseFunnels(serveJson) {
    if (!serveJson || typeof serveJson !== 'object') return [];
    const flagMap = serveJson.Funnel ?? serveJson.AllowFunnel ?? {};
    const webMap  = serveJson.Web ?? {};
    const out = [];
    for (const key of Object.keys(flagMap)) {
        if (!flagMap[key]) continue;
        const m = key.match(/^(.+):(\d+)$/);
        if (!m) continue;
        const [, host, portStr] = m;
        const httpsPort = parseInt(portStr, 10);
        let target = '';
        const web = webMap[key];
        if (web?.Handlers) {
            const slash = web.Handlers['/'] || Object.values(web.Handlers)[0];
            if (slash) {
                target = slash.Proxy || slash.Text || (slash.Path ? `file:${slash.Path}` : '');
            }
        }
        out.push({ httpsPort, target, host });
    }
    out.sort((a, b) => a.httpsPort - b.httpsPort);
    return out;
}

function _buildSnapshot(statusJson, prefsJson, accounts, canControl, funnels) {
    if (!statusJson) {
        return { ...EMPTY_SNAPSHOT, accounts, canControl, funnels, error: 'no-status' };
    }
    const self = statusJson.Self ?? {};
    const tailnet = statusJson.CurrentTailnet ?? null;
    const peers = _peersFromStatus(statusJson, prefsJson);
    const exitNodes = peers.filter((p) => p.exitNodeOption);
    const currentExitNode = peers.find((p) => p.exitNode) ?? null;
    const operatorUser = prefsJson?.OperatorUser || null;

    // Flatten { cidr, peer } pairs. Sorted so the UI is stable.
    const advertisedRoutes = [];
    for (const peer of peers)
        for (const cidr of peer.advertisedRoutes)
            advertisedRoutes.push({ cidr, peer: peer.hostname || peer.dnsName });
    advertisedRoutes.sort((a, b) => a.cidr.localeCompare(b.cidr));

    return {
        backendState: statusJson.BackendState ?? 'NoState',
        running: statusJson.BackendState === 'Running',
        loggedOut: !!prefsJson?.LoggedOut,
        version: statusJson.Version ?? '',
        accountName: tailnet?.Name ?? null,
        tailnetName: tailnet?.Name ?? null,
        magicDNSSuffix: statusJson.MagicDNSSuffix || tailnet?.MagicDNSSuffix || null,
        hostname: self.HostName ?? null,
        dnsName: _stripDot(self.DNSName ?? ''),
        selfIps: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [],
        peers,
        exitNodes,
        currentExitNode,
        advertisedRoutes,
        health: Array.isArray(statusJson.Health) ? statusJson.Health : [],
        prefs: prefsJson ?? {},
        acceptRoutes: !!prefsJson?.RouteAll,
        acceptDNS: prefsJson?.CorpDNS ?? true,
        allowLanAccess: !!prefsJson?.ExitNodeAllowLANAccess,
        shieldsUp: !!prefsJson?.ShieldsUp,
        runSSH: !!prefsJson?.RunSSH,
        exitNodeID: prefsJson?.ExitNodeID || null,
        // auto:any can appear as a magic string in ExitNodeID (older Tailscale)
        // or as a separate AutoExitNode bool (newer). We normalise both into one
        // flag so the menu can use a single check.
        autoExitNode: !!(prefsJson?.AutoExitNode) || prefsJson?.ExitNodeID === 'auto:any',
        accounts,
        operatorUser,
        canControl,
        funnels,
        error: null,
    };
}

/* -------------------------------------------------------------------------- */
/*                            Account list parser                             */
/* -------------------------------------------------------------------------- */

// `tailscale switch --list` example:
//
//   ID    Tailnet             Account
//   3c95  gillet.mat@free.fr  gillet.mat@free.fr
//   13ee  gillet.fra@free.fr  yoga-diskmth.hair-acoustic.ts.net*
//
// The trailing "*" marks the current account.
function _parseSwitchList(text) {
    const accounts = [];
    if (!text) return accounts;
    const lines = text.trim().split('\n');
    if (lines.length < 2) return accounts;
    for (const raw of lines.slice(1)) {
        const line = raw.trim();
        if (!line) continue;
        const cols = line.split(/\s{2,}|\t+/).filter((c) => c.length > 0);
        if (cols.length < 3) continue;
        let [id, tailnet, account] = cols;
        let current = false;
        if (account.endsWith('*')) {
            current = true;
            account = account.slice(0, -1).trim();
        }
        accounts.push({ id, tailnet, account, current });
    }
    return accounts;
}

/* -------------------------------------------------------------------------- */
/*                                  Client                                    */
/* -------------------------------------------------------------------------- */

export const TailscaleClient = GObject.registerClass(
    {
        GTypeName: 'TailscaleClient',
        Signals: {
            'state-changed': { param_types: [GObject.TYPE_JSOBJECT] },
            'busy-changed': { param_types: [GObject.TYPE_BOOLEAN] },
            'error': { param_types: [GObject.TYPE_STRING] },
            'notify-info': { param_types: [GObject.TYPE_STRING] },
        },
    },
    class TailscaleClient extends GObject.Object {
        _init(params = {}) {
            super._init();
            this._bin = params.binary || DEFAULT_BIN;
            this._pollSeconds = params.pollSeconds || 5;
            this._cancellable = new Gio.Cancellable();
            this._snapshot = { ...EMPTY_SNAPSHOT };
            this._timerId = 0;
            this._inflight = false;
            this._busyCount = 0;
            this._destroyed = false;
        }

        /** Most recent normalized snapshot. Always non-null. */
        get snapshot() {
            return this._snapshot;
        }

        get binary() {
            return this._bin;
        }

        setBinary(path) {
            if (!path || path === this._bin) return;
            this._bin = path;
            // Force an immediate reconciliation against the new binary.
            this.refresh().catch(() => {});
        }

        setPollSeconds(seconds) {
            const clamped = Math.max(2, Math.min(60, seconds | 0));
            if (clamped === this._pollSeconds) return;
            this._pollSeconds = clamped;
            this._restartTimer();
        }

        /** Begin polling. Idempotent. */
        start() {
            if (this._destroyed) return;
            this._restartTimer();
            // Kick off an immediate refresh so the UI never starts blank.
            this.refresh().catch(() => {});
        }

        /** Stop polling and cancel anything in flight. */
        destroy() {
            if (this._destroyed) return;
            this._destroyed = true;
            this._stopTimer();
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
                this._pollSeconds,
                () => {
                    if (this._destroyed) return GLib.SOURCE_REMOVE;
                    if (!this._inflight) this.refresh().catch(() => {});
                    return GLib.SOURCE_CONTINUE;
                },
            );
        }

        _setBusy(delta) {
            const was = this._busyCount > 0;
            this._busyCount = Math.max(0, this._busyCount + delta);
            const now = this._busyCount > 0;
            if (was !== now) this.emit('busy-changed', now);
        }

        async _run(args, opts = {}) {
            const argv = [this._bin, ...args];
            this._setBusy(+1);
            try {
                return await _spawn(argv, { cancellable: this._cancellable, ...opts });
            } finally {
                this._setBusy(-1);
            }
        }

        // Privileged variant: wraps the command in `pkexec` so the daemon
        // accepts it even without operator (or when checkprefs is denying
        // operator-set users — a known Tailscale quirk affecting `login`,
        // `logout`, and `set --operator`).
        async _runPriv(args, opts = {}) {
            const argv = ['pkexec', this._bin, ...args];
            this._setBusy(+1);
            try {
                return await _spawn(argv, { cancellable: this._cancellable, ...opts });
            } finally {
                this._setBusy(-1);
            }
        }

        /**
         * Set this Unix user as the daemon's operator (writes the OperatorUser
         * pref). Requires root → routed through pkexec, so the user gets a
         * single polkit password prompt. The pref is per-profile, which means
         * any subsequent `tailscale login` (which creates a new profile) wipes
         * it — callers can re-invoke this method when needed.
         */
        async setOperator() {
            const user = GLib.get_user_name();
            const r = await this._runPriv(['set', `--operator=${user}`]);
            const ok = r.ok && !_isAccessDenied(r);
            if (!ok) {
                const msg = (r.stderr || r.stdout).split('\n')[0]?.trim() ||
                    `exit ${r.code}`;
                this.emit('error', `Set operator: ${msg}`);
            } else {
                this.emit('notify-info', `Operator set to ${user}`);
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
            if (!r.ok || _isAccessDenied(r)) return { accounts: [], denied: _isAccessDenied(r) };
            return { accounts: _parseSwitchList(r.stdout), denied: false };
        }

        async _fetchFunnels() {
            // `funnel status --json` returns `{}` when no serve config exists.
            // Treat any failure as "no funnels" rather than tanking the snap.
            const r = await this._run(['funnel', 'status', '--json']);
            if (!r.ok) return [];
            try {
                return _parseFunnels(JSON.parse(r.stdout));
            } catch {
                return [];
            }
        }

        /**
         * Fetch a fresh snapshot and emit 'state-changed' iff it changed.
         * Returns the new snapshot.
         */
        async refresh() {
            if (this._destroyed) return this._snapshot;
            if (this._inflight) return this._snapshot;
            this._inflight = true;
            try {
                const [status, prefs, accountsResult, funnels] = await Promise.all([
                    this._fetchStatus(),
                    this._fetchPrefs(),
                    this._fetchAccounts(),
                    this._fetchFunnels(),
                ]);
                const canControl = !accountsResult.denied;
                const accounts = accountsResult.accounts;
                let snap;
                if (!status.ok) {
                    snap = { ...EMPTY_SNAPSHOT, accounts, canControl, funnels, error: status.err };
                } else {
                    snap = _buildSnapshot(status.json, prefs, accounts, canControl, funnels);
                }
                if (!_snapshotEqual(snap, this._snapshot)) {
                    this._snapshot = snap;
                    this.emit('state-changed', snap);
                }
                return snap;
            } catch (e) {
                this.emit('error', String(e?.message ?? e));
                return this._snapshot;
            } finally {
                this._inflight = false;
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
            const denied = _isAccessDenied(r);
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

        // logout creates/clears profile state — Tailscale denies it for
        // operator-set users (same "checkprefs"/"logout access denied"
        // quirk that hits login). Go through pkexec so it actually works.
        //
        // We chain `logout && set --operator` under a single pkexec call so
        // the user gets ONE polkit prompt instead of two (one for the logout
        // and a follow-up one fired by the state-changed auto-prompt the
        // moment OperatorUser drops). The chain is a /bin/sh invocation so
        // we keep argument quoting tight — `bin` and `user` are validated
        // shell tokens here (alnum / dot / slash / underscore / dash).
        async logout() {
            const user = GLib.get_user_name();
            const bin = this._bin;
            // Reject any shell metachars in the binary path or username; if
            // someone manages to inject those into the settings, we'd rather
            // refuse than feed them to /bin/sh -c.
            if (!/^[A-Za-z0-9_./-]+$/.test(bin) || !/^[A-Za-z0-9_.-]+$/.test(user)) {
                this.emit('error', 'Refusing to run logout: unsafe binary/user');
                return { ok: false, message: 'unsafe' };
            }
            const script = `${bin} logout && ${bin} set --operator=${user}`;
            const r = await this._setBusyWrap(() =>
                _spawn(['pkexec', '/bin/sh', '-c', script],
                    { cancellable: this._cancellable }));
            const denied = _isAccessDenied(r);
            const ok = r.ok && !denied;
            if (!ok) {
                const msg = (r.stderr || r.stdout).split('\n')[0]?.trim() ||
                    `exit ${r.code}`;
                if (r.code === 126 || r.code === 127)
                    this.emit('error', 'Logout: admin authentication cancelled');
                else
                    this.emit('error', `tailscale logout: ${msg}`);
            }
            await this.refresh();
            return { ok, message: (r.stderr || r.stdout).trim() };
        }

        async _setBusyWrap(fn) {
            this._setBusy(+1);
            try { return await fn(); } finally { this._setBusy(-1); }
        }

        /**
         * Interactive login. Routed through `pkexec` because Tailscale 1.96
         * denies `tailscale login` even when OperatorUser is set ("Access
         * denied: checkprefs access denied" — the daemon doesn't run the
         * operator check while the profile is in a half-initialised state).
         *
         * We also pass `--operator=$USER` so the brand-new profile that
         * `login` creates already has the operator set, avoiding a second
         * polkit prompt every time and the "now toggle is broken again"
         * trap right after the browser flow completes.
         *
         * Stream handling: read stdout AND stderr in parallel (the auth URL
         * is on stderr in current versions), open the browser the moment we
         * see an `https://...` URL, then wait for the child to exit to
         * distinguish three outcomes:
         *
         *   1. URL printed → browser opened, login pending.
         *   2. Exit 0 with no URL → already authenticated (silent success).
         *   3. Exit ≠ 0, or "Access denied" anywhere → real error
         *      (typically: user dismissed the polkit dialog).
         */
        async login() {
            const user = GLib.get_user_name();
            let proc;
            try {
                proc = Gio.Subprocess.new(
                    ['pkexec', this._bin, 'login', `--operator=${user}`],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                );
            } catch (e) {
                this.emit('error', `Login: failed to spawn (${e.message ?? e})`);
                return { ok: false, message: String(e.message ?? e) };
            }

            let urlFound = false;

            const tryLaunchUrl = (line) => {
                if (urlFound) return;
                const m = line.match(/https?:\/\/\S+/);
                if (!m) return;
                urlFound = true;
                const url = m[0];
                try { Gio.AppInfo.launch_default_for_uri(url, null); } catch (_) {}
                this.emit('notify-info', `Login: opened ${url}`);
            };

            const readStream = (stream, buf) => {
                const dis = new Gio.DataInputStream({
                    base_stream: stream,
                    close_base_stream: true,
                });
                const loop = () => {
                    dis.read_line_async(
                        GLib.PRIORITY_DEFAULT, this._cancellable,
                        (obj, res) => {
                            try {
                                const [line] = obj.read_line_finish_utf8(res);
                                if (line === null) return;            // EOF
                                buf.text += line + '\n';
                                tryLaunchUrl(line);
                                loop();
                            } catch (_) { /* cancelled or stream closed */ }
                        },
                    );
                };
                loop();
            };

            const outBuf = { text: '' };
            const errBuf = { text: '' };
            readStream(proc.get_stdout_pipe(), outBuf);
            readStream(proc.get_stderr_pipe(), errBuf);

            proc.wait_async(this._cancellable, (p, res) => {
                try { p.wait_finish(res); } catch (_) { return; }
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
                    this.emit('notify-info', 'Login: authentication did not complete');
                } else if (!urlFound && code === 0) {
                    // Silent success: already authenticated, no URL needed.
                    this.emit('notify-info', 'Login: already authenticated');
                } else {
                    // urlFound && code === 0: browser flow completed.
                    this.emit('notify-info', 'Logged in to Tailscale');
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
            const sr = await this._run(['switch', id]);
            const denied = _isAccessDenied(sr);
            if (!sr.ok || denied) {
                if (!denied) {
                    const msg = (sr.stderr || sr.stdout).split('\n')[0]?.trim() ||
                        `exit ${sr.code}`;
                    this.emit('error', `tailscale switch ${id}: ${msg}`);
                }
                await this.refresh();
                return { ok: false, denied, message: (sr.stderr || sr.stdout).trim() };
            }

            // Always connect to the switched-to account. Peek at its state
            // so we know whether `up` is enough or whether the profile
            // needs the interactive login flow.
            const [stR, prR] = await Promise.all([
                this._run(['status', '--json']),
                this._run(['debug', 'prefs']),
            ]);
            let needsLogin = false, loggedOut = false;
            try { needsLogin = JSON.parse(stR.stdout)?.BackendState === 'NeedsLogin'; }
            catch {}
            try { loggedOut = !!JSON.parse(prR.stdout)?.LoggedOut; }
            catch {}

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

        /**
         * Add a funnel that exposes a local service on the public internet.
         * @param {number|string} localTarget  Local port number or full target
         *                                     (e.g. 3000, "localhost:3000",
         *                                     "http://localhost:8080/foo").
         * @param {number} httpsPort           Public HTTPS port on the device
         *                                     (443 by default; 8443 / 10000
         *                                     are the only other Funnel ports).
         */
        addFunnel(localTarget, httpsPort = 443) {
            // Do NOT pass --bg: with recent Tailscale the funnel command sets a
            // persistent serve config and exits immediately. --bg makes the CLI
            // fork a foreground serve daemon that never exits, causing
            // communicate_utf8_async to hang forever and the button to stay
            // grayed out.
            return this._runAndRefresh([
                'funnel', `--https=${httpsPort}`, String(localTarget),
            ]);
        }

        /** Disable the funnel on a specific HTTPS port. */
        removeFunnel(httpsPort = 443) {
            return this._runAndRefresh([
                'funnel', `--https=${httpsPort}`, 'off',
            ]);
        }

        /** Clear every funnel and serve entry. */
        resetFunnels() {
            return this._runAndRefresh(['funnel', 'reset']);
        }
    },
);

/* -------------------------------------------------------------------------- */
/*                              Equality helper                               */
/* -------------------------------------------------------------------------- */

// Cheap structural compare. Only the fields the UI binds to. Avoids
// re-rendering on every tick when nothing changed.
function _snapshotEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.backendState !== b.backendState) return false;
    if (a.running !== b.running) return false;
    if (a.loggedOut !== b.loggedOut) return false;
    if (a.accountName !== b.accountName) return false;
    if (a.hostname !== b.hostname) return false;
    if (a.exitNodeID !== b.exitNodeID) return false;
    if (a.autoExitNode !== b.autoExitNode) return false;
    if (a.acceptRoutes !== b.acceptRoutes) return false;
    if (a.acceptDNS !== b.acceptDNS) return false;
    if (a.allowLanAccess !== b.allowLanAccess) return false;
    if (a.shieldsUp !== b.shieldsUp) return false;
    if (a.runSSH !== b.runSSH) return false;
    if (a.canControl !== b.canControl) return false;
    if (a.operatorUser !== b.operatorUser) return false;
    if ((a.magicDNSSuffix || '') !== (b.magicDNSSuffix || '')) return false;
    if (a.advertisedRoutes.length !== b.advertisedRoutes.length) return false;
    for (let i = 0; i < a.advertisedRoutes.length; i++) {
        if (a.advertisedRoutes[i].cidr !== b.advertisedRoutes[i].cidr ||
            a.advertisedRoutes[i].peer !== b.advertisedRoutes[i].peer)
            return false;
    }
    if ((a.funnels?.length || 0) !== (b.funnels?.length || 0)) return false;
    for (let i = 0; i < (a.funnels?.length || 0); i++) {
        const x = a.funnels[i], y = b.funnels[i];
        if (x.httpsPort !== y.httpsPort || x.target !== y.target || x.host !== y.host)
            return false;
    }
    if ((a.error || null) !== (b.error || null)) return false;
    if (!_arrEq(a.selfIps, b.selfIps)) return false;
    if (!_arrEq(a.health, b.health)) return false;
    if (a.peers.length !== b.peers.length) return false;
    for (let i = 0; i < a.peers.length; i++) {
        const p = a.peers[i];
        const q = b.peers[i];
        if (
            p.id !== q.id ||
            p.hostname !== q.hostname ||
            p.online !== q.online ||
            p.active !== q.active ||
            p.exitNode !== q.exitNode ||
            p.exitNodeOption !== q.exitNodeOption ||
            !_arrEq(p.ips, q.ips)
        )
            return false;
    }
    if (a.accounts.length !== b.accounts.length) return false;
    for (let i = 0; i < a.accounts.length; i++) {
        const x = a.accounts[i];
        const y = b.accounts[i];
        if (x.id !== y.id || x.account !== y.account || x.current !== y.current) return false;
    }
    return true;
}

function _arrEq(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
