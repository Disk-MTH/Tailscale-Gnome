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

        up()     { return this._runAndRefresh(['up']); }
        down()   { return this._runAndRefresh(['down']); }
        logout() { return this._runAndRefresh(['logout']); }

        /**
         * Login is interactive (prints an auth URL). We launch it detached so
         * we don't block. The user sees the URL via journalctl / xdg-open.
         */
        async login() {
            try {
                Gio.Subprocess.new([this._bin, 'login'], Gio.SubprocessFlags.NONE);
            } catch (e) {
                this.emit('error', `login failed to spawn: ${e.message ?? e}`);
            }
            // Give the daemon a moment to update before we poll.
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                this.refresh().catch(() => {});
                return GLib.SOURCE_REMOVE;
            });
            return { ok: true, message: 'login started' };
        }

        async switchAccount(id) {
            if (!id) return { ok: false, message: 'missing account id' };
            // Preserve the user's connection state across the switch: if we
            // were running before, stay running on the new account; if we were
            // stopped, stay stopped. `tailscale switch` itself leaves the
            // daemon in whatever state the new profile last had, which is
            // surprising. This normalizes that.
            const wasRunning = this._snapshot.running;
            const result = await this._runAndRefresh(['switch', id]);
            if (!result.ok) return result;

            // Re-read the snapshot post-switch. The new profile may have
            // expired auth (e.g. a tailnet you haven't used in a while), in
            // which case `up` would fail noisily and the user would need to
            // click again to trigger login. Detect that here and dispatch
            // login() instead. Mirrors the toggle's user-click logic.
            const cur = this._snapshot;
            if (wasRunning) {
                if (cur.running) return result;
                if (cur.loggedOut || cur.backendState === 'NeedsLogin') {
                    await this.login();
                } else {
                    // Quiet because a transient up failure right after switch
                    // is common; if it persists, the next poll surfaces the
                    // real state via the menu.
                    await this._runAndRefresh(['up'], { quiet: true });
                }
            } else if (cur.running) {
                await this._runAndRefresh(['down'], { quiet: true });
            }
            return result;
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
            return this._runAndRefresh([
                'funnel', '--bg', `--https=${httpsPort}`, String(localTarget),
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
