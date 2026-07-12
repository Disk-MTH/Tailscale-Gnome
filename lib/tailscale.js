// TailscaleClient: async CLI wrapper that polls `tailscale status --json`
// and emits 'state-changed' when its parsed snapshot mutates. Everything
// goes through Gio.Subprocess so the main loop never blocks.
//
// Privileged operations: on Linux the Tailscale daemon only accepts
// state-changing commands from root or from the Unix user named in its
// OperatorUser pref. Three entry points below (setOperator, login, logout)
// therefore run through `pkexec` with a literal, fixed argument vector —
// EGO review requires the full elevated command to be readable in the
// source. That is also why these calls hardcode the `tailscale` program
// name instead of honouring the user-configurable binary setting: pkexec
// resolves the name in its own trusted root PATH, so no user-writable
// path is ever elevated. Every privileged command is listed verbatim in
// README.md under "Privileged operations".

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

const DEFAULT_BIN = 'tailscale';

// Node capability published by the daemon in `status --json` Self.CapMap
// when the tailnet allows Taildrop for this device.
const CAP_FILE_SHARING = 'https://tailscale.com/cap/file-sharing';

// Public ports Funnel can bind (platform limit). The daemon advertises
// the authoritative list in a CapMap key such as
// `https://tailscale.com/cap/funnel-ports?ports=443,8443,10000`; this
// constant is the fallback when that key is absent.
const FUNNEL_PORTS_FALLBACK = Object.freeze([443, 8443, 10000]);

function _funnelPortsFromCapMap(capMap) {
    for (const key of Object.keys(capMap ?? {})) {
        const m = key.match(/^https:\/\/tailscale\.com\/cap\/funnel-ports\?ports=([\d,]+)$/);
        if (!m) continue;
        const ports = m[1].split(',')
            .map((p) => parseInt(p, 10))
            .filter((p) => Number.isInteger(p) && p > 0 && p <= 65535);
        if (ports.length > 0) return ports;
    }
    return FUNNEL_PORTS_FALLBACK;
}

/**
 * Run a child process asynchronously and resolve with { ok, code, stdout, stderr }.
 * Never throws on non-zero exit. Callers decide how to react.
 */
function _spawn(argv, cancellable = null) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            );
        } catch (e) {
            reject(e);
            return;
        }

        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                resolve({
                    ok: p.get_successful(),
                    code: p.get_exit_status(),
                    stdout: stdout ?? '',
                    stderr: stderr ?? '',
                });
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
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
 * @property {Peer[]}  exitNodes      Subset advertising exit-node service
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
    funnelPorts: FUNNEL_PORTS_FALLBACK,
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
    const currentExitID = prefs?.ExitNodeID ?? statusJson.ExitNodeStatus?.ID ?? '';
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
        funnelPorts: _funnelPortsFromCapMap(self.CapMap),
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
            this._settings = params.settings || null;
            this._cancellable = new Gio.Cancellable();
            this._snapshot = { ...EMPTY_SNAPSHOT };
            this._timerId = 0;
            this._inflight = false;
            this._busyCount = 0;
            this._funnelTimeoutIds = new Set();
        }

        /** Most recent normalized snapshot. Always non-null. */
        get snapshot() {
            return this._snapshot;
        }

        setBinary(path) {
            if (!path || path === this._bin) return;
            this._bin = path;
            // Force an immediate reconciliation against the new binary.
            this.refresh().catch(() => {});
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

        /**
         * One-shot Taildrop + Funnel availability probe. Called once at
         * startup and on account changes so the cached gsettings flags
         * stay in sync with the current tailnet's ACL. Availability is
         * read from the node capability map the daemon publishes in
         * `status --json` (Self.CapMap): the `funnel` node attribute and
         * the file-sharing capability. Best-effort: a failed or cancelled
         * fetch, or a daemon too old to publish CapMap, leaves the cached
         * flags untouched so a transient hiccup doesn't grey out the UI.
         */
        async probeAvailability() {
            if (!this._settings) return;
            const r = await this._run(['status', '--json']);
            if (!r.ok) return;
            let capMap;
            try {
                capMap = JSON.parse(r.stdout).Self?.CapMap;
            } catch {
                return;
            }
            if (!capMap) return;
            this._settings.set_boolean('feature-taildrop-available',
                Object.prototype.hasOwnProperty.call(capMap, CAP_FILE_SHARING));
            this._settings.set_boolean('feature-funnels-available',
                Object.prototype.hasOwnProperty.call(capMap, 'funnel'));
        }

        /** Stop polling, kill owned subprocesses and cancel anything in flight. */
        destroy() {
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
                this._pollSeconds,
                () => {
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

        async _run(args) {
            const argv = [this._bin, ...args];
            this._setBusy(+1);
            try {
                return await _spawn(argv, this._cancellable);
            } finally {
                this._setBusy(-1);
            }
        }

        // Privileged variant: wraps the command in `pkexec` so the daemon
        // accepts it even without operator (or when checkprefs is denying
        // operator-set users — a known Tailscale quirk affecting `login`,
        // `logout`, and `set --operator`). The program name is a literal:
        // pkexec resolves it in its own trusted root PATH, so the
        // user-configurable binary setting never reaches an elevated call
        // and the full command is readable right here.
        async _runPriv(args) {
            const argv = ['pkexec', 'tailscale', ...args];
            this._setBusy(+1);
            try {
                return await _spawn(argv, this._cancellable);
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
            if (this._inflight) return this._snapshot;
            this._inflight = true;
            try {
                const [status, prefs, accountsResult, funnels] = await Promise.all([
                    this._fetchStatus(),
                    this._fetchPrefs(),
                    this._fetchAccounts(),
                    this._fetchFunnels(),
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
                    snap = _buildSnapshot(status.json, prefs, accounts, canControl, funnels);
                }
                if (!_snapshotEqual(snap, this._snapshot)) {
                    this._snapshot = snap;
                    this.emit('state-changed', snap);
                }
                return snap;
            } catch (e) {
                this.emit('error', String(e.message ?? e));
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

        // Logout, then re-grant the operator. Logging out wipes the
        // daemon's OperatorUser pref along with the discarded profile,
        // which would lock the extension out until the operator is set
        // again — so a second fixed `set --operator` call follows right
        // away. Two separate polkit prompts: EGO review requires every
        // privileged command to be a literal argv readable in the source,
        // which rules out the previous single-prompt `sh -c 'logout &&
        // set …'` chain.
        async logout() {
            const r = await this._runPriv(['logout']);
            const denied = _isAccessDenied(r);
            const ok = r.ok && !denied;
            if (!ok) {
                const msg = (r.stderr || r.stdout).split('\n')[0]?.trim() ||
                    `exit ${r.code}`;
                if (r.code === 126 || r.code === 127)
                    this.emit('error', 'Logout: admin authentication cancelled');
                else
                    this.emit('error', `tailscale logout: ${msg}`);
                await this.refresh();
                return { ok, message: (r.stderr || r.stdout).trim() };
            }
            // setOperator refreshes on its own; if the user dismisses this
            // second prompt the logout still stands and the menu falls
            // back to its "Operator not set" gate.
            await this.setOperator();
            return { ok: true, message: '' };
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
            let proc;
            try {
                proc = Gio.Subprocess.new(
                    ['pkexec', 'tailscale', 'login', `--operator=${user}`],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                );
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
                            } catch { /* cancelled or stream closed */ }
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

        // Expose a local service to the public internet via Tailscale Funnel.
        // Streams the CLI output instead of waiting for exit because the
        // command blocks indefinitely when Funnel is not yet enabled for the
        // tailnet (it polls the control plane until the admin clicks the
        // approval URL it printed). We detect that URL, surface it, and kill
        // the child so the caller isn't stuck waiting.
        //
        // Resolves with:
        //   { ok: true }              — funnel set, snapshot will refresh
        //   { notEnabled: true, url } — open the URL, ask the user to retry
        //   { ok: false, message }    — first error line
        addFunnel(localTarget, httpsPort = 443) {
            return new Promise((resolve) => {
                // Refuse to silently replace an existing funnel: `funnel
                // --bg` on an occupied port would overwrite its serve
                // config. The Add dialog greys occupied ports out already;
                // this is the backstop for a stale snapshot.
                if (this._snapshot.funnels.some((f) => f.httpsPort === httpsPort)) {
                    resolve({
                        ok: false,
                        message: `Port ${httpsPort} already has a funnel — remove it first.`,
                    });
                    return;
                }
                let proc;
                try {
                    proc = Gio.Subprocess.new(
                        [this._bin, 'funnel', '--bg', '--yes',
                         `--https=${httpsPort}`, String(localTarget)],
                        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                    );
                } catch (e) {
                    resolve({ ok: false, message: e.message });
                    return;
                }
                this._setBusy(+1);

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
                    this._setBusy(-1);
                    this.refresh().catch(() => {});
                    resolve(r);
                };

                const readLines = (stream, isErr) => {
                    const dis = new Gio.DataInputStream({
                        base_stream: stream, close_base_stream: true,
                    });
                    const loop = () => {
                        dis.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable,
                            (obj, res) => {
                                let line;
                                try {
                                    [line] = obj.read_line_finish_utf8(res);
                                } catch {
                                    return;  // cancelled or stream closed
                                }
                                if (line === null) return;
                                if (isErr) errBuf += line + '\n';
                                else       outBuf += line + '\n';
                                if (/funnel is not enabled/i.test(line))
                                    sawNotEnabled = true;
                                if (sawNotEnabled) {
                                    const m = line.match(/https?:\/\/\S+/);
                                    if (m) { finish({ notEnabled: true, url: m[0] }); return; }
                                }
                                loop();
                            });
                    };
                    loop();
                };
                readLines(proc.get_stdout_pipe(), false);
                readLines(proc.get_stderr_pipe(), true);

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
            if (r.ok) this.emit('notify-info', 'Funnel removed');
            return r;
        }

        /** Clear every funnel and serve entry. */
        resetFunnels() {
            return this._runAndRefresh(['funnel', 'reset']);
        }

        /* ----------------------------- Taildrop -------------------------- */

        get acceptingFiles() { return !!this._receiver; }

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
            const dir = this._resolveInbox(inbox);
            try {
                this._ensureDir(dir);
            } catch (e) {
                this.emit('error', `Taildrop: cannot create inbox (${e.message})`);
                return;
            }
            this._watchInbox(dir);

            let proc;
            try {
                proc = Gio.Subprocess.new(
                    [this._bin, 'file', 'get', '--loop', '--conflict=rename', '--verbose', dir],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                );
            } catch (e) {
                this.emit('error', `Taildrop receiver: ${e.message}`);
                return;
            }
            this._receiver = proc;
            this._receiverInbox = dir;

            // Surface inbound file events. Verbose mode prints two kinds of
            // lines we care about:
            //   - "got <file> from <peer>" (or "received <file> from <peer>")
            //   - "wrote <path>"
            // We remember the most recent sender from the "got/received" line
            // and pair it with the next "wrote" line so the notification can
            // say "Received <file> from <peer>". File size is intentionally
            // dropped from the message.
            this._pendingSender = null;
            const readLines = (stream) => {
                const dis = new Gio.DataInputStream({
                    base_stream: stream, close_base_stream: true,
                });
                const loop = () => {
                    dis.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable,
                        (obj, res) => {
                            let line;
                            try {
                                [line] = obj.read_line_finish_utf8(res);
                            } catch {
                                return;  // cancelled or stream closed
                            }
                            if (line === null) return;
                            const t = line.trim();
                            // Try to extract a sender for the next "wrote" line.
                            const senderMatch = t.match(/\b(?:got|received)\b[\s\S]*?\bfrom\s+([^\s,;)]+)/i);
                            if (senderMatch) this._pendingSender = senderMatch[1];

                            const m = t.match(/wrote\s+(.+?)$/i);
                            if (m) {
                                const base = m[1].split('/').pop();
                                const peer = this._pendingSender;
                                this._pendingSender = null;
                                this.emit('notify-info',
                                    peer ? `Received ${base} from ${peer}`
                                        : `Received ${base}`);
                            }
                            loop();
                        });
                };
                loop();
            };
            readLines(proc.get_stdout_pipe());
            readLines(proc.get_stderr_pipe());

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
                    // on next file arrival. The source is removed by
                    // _stopReceiver (user toggle-off and destroy both land
                    // there), so it cannot fire after teardown.
                    this._receiverRestartId = GLib.timeout_add_seconds(
                        GLib.PRIORITY_DEFAULT, 3, () => {
                            this._receiverRestartId = 0;
                            this._startReceiver(this._receiverInbox);
                            return GLib.SOURCE_REMOVE;
                        });
                }
            });
        }

        _stopReceiver() {
            if (this._receiverRestartId) {
                GLib.source_remove(this._receiverRestartId);
                this._receiverRestartId = 0;
            }
            this._unwatchInbox();
            if (!this._receiver) return;
            const proc = this._receiver;
            this._receiver = null;
            proc.force_exit();
        }

        // Watch the inbox's parent for deletion of the inbox itself.
        // `tailscale file get --loop` does NOT exit when its target dir
        // disappears — it just keeps failing silently. Recreating the
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
        // line) — despite the subcommand's name, nothing is copied. The
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
                const denied = _isAccessDenied(r) || featureBlocked;
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
         * Send one or more local files to a target peer via Taildrop —
         * `tailscale file cp` is the CLI's network-transfer subcommand,
         * not a filesystem copy. `target` is a hostname / DNS name / IP
         * (without the trailing colon; we add it).
         */
        async sendFile(target, files) {
            if (!target || !files || files.length === 0)
                return { ok: false, message: 'missing target or files' };
            const r = await this._run(['file', 'cp', ...files, `${target}:`]);
            const denied = _isAccessDenied(r);
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
                this.emit('notify-info', note);
            }
            return { ok, message: (r.stderr || r.stdout).trim() };
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
    if (a.funnels.length !== b.funnels.length) return false;
    for (let i = 0; i < a.funnels.length; i++) {
        const x = a.funnels[i], y = b.funnels[i];
        if (x.httpsPort !== y.httpsPort || x.target !== y.target || x.host !== y.host)
            return false;
    }
    if ((a.error || null) !== (b.error || null)) return false;
    if (!_arrEq(a.selfIps, b.selfIps)) return false;
    if (!_arrEq(a.funnelPorts, b.funnelPorts)) return false;
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
