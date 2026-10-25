// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// Everything the client does with the CLI's output once it has it: turning
// `tailscale status --json`, `serve status --json`, `switch --list` and the
// receiver's verbose lines into the snapshot the UI binds to, and comparing
// two snapshots to decide whether a render is owed.
//
// Deliberately free of gi imports. These are pure functions over parsed JSON
// and strings, which is what lets tests/tailscale.test.js exercise the whole
// parsing surface without a Shell session or a Tailscale install.

import { CAP_FILE_SHARING, CAP_FUNNEL, CAP_HTTPS } from './util.js';

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
 * @typedef {object} Route
 * @property {string}  cidr            Advertised subnet, e.g. "192.168.1.0/24"
 * @property {string}  peer            Hostname of the peer advertising it
 *
 * @typedef {object} Funnel
 * @property {number}  httpsPort       Public port (443 | 8443 | 10000), whatever the kind
 * @property {'https'|'tcp'|'tls-tcp'} kind
 *                                     HTTPS server, raw TCP forwarder, or TCP
 *                                     forwarder behind TLS terminated here
 * @property {string}  path            Mount point of an HTTPS funnel ("/" by
 *                                     default); empty for the TCP kinds
 * @property {'proxy'|'path'|'text'} handler
 *                                     What an HTTPS funnel serves: a proxied
 *                                     local server, a file or folder, or
 *                                     fixed text. Always 'proxy' for TCP.
 * @property {string}  target          The proxied address, served path or text
 * @property {number}  proxyProtocol   PROXY protocol version sent to a TCP
 *                                     target, 0 for none
 * @property {boolean} public          On the internet (Funnel) rather than
 *                                     only within the tailnet (Serve)
 * @property {string}  host            Public hostname serving it
 *
 * @typedef {object} Snapshot
 * @property {string}  backendState    e.g. "Running" | "Stopped" | "NeedsLogin" | …
 * @property {boolean} running         backendState === "Running"
 * @property {boolean} loggedOut
 * @property {string|null} accountName Display name of the current tailnet
 * @property {string|null} magicDNSSuffix
 * @property {string|null} hostname    Self.HostName
 * @property {string|null} selfDnsName Self.DNSName, no trailing dot
 * @property {string[]} selfIps        Self.TailscaleIPs
 * @property {Peer[]}  peers           All peers, sorted by hostname
 * @property {Peer[]}  exitNodes       Subset advertising exit-node service
 * @property {Peer|null} currentExitNode
 * @property {Route[]} advertisedRoutes
 * @property {Funnel[]} funnels       Published on the internet
 * @property {Funnel[]} serves        Shared within the tailnet only
 * @property {number[]} funnelPorts    Public ports Funnel may bind
 * @property {boolean} acceptRoutes
 * @property {boolean} acceptDNS
 * @property {boolean} allowLanAccess
 * @property {boolean} shieldsUp
 * @property {boolean} runSSH
 * @property {string|null} exitNodeID
 * @property {boolean} autoExitNode    true when --exit-node=auto:any is active
 * @property {Account[]} accounts
 * @property {boolean} canControl      false once access-denied was observed
 * @property {boolean} installed       false when the CLI is not on PATH
 * @property {string|null} error
 *
 * @typedef {object} Account
 * @property {string}  id
 * @property {string}  tailnet
 * @property {string}  account
 * @property {boolean} current
 */

export const EMPTY_SNAPSHOT = Object.freeze({
    backendState: 'NoState',
    running: false,
    loggedOut: false,
    accountName: null,
    magicDNSSuffix: null,
    hostname: null,
    selfIps: [],
    peers: [],
    exitNodes: [],
    currentExitNode: null,
    advertisedRoutes: [],   // [{ cidr, peer }, …]
    funnels: [],            // [Funnel, …], see parseFunnels()
    serves: [],             // [Funnel, …], see parseServes()
    selfDnsName: null,
    funnelPorts: FUNNEL_PORTS_FALLBACK,
    acceptRoutes: false,
    acceptDNS: true,
    allowLanAccess: false,
    shieldsUp: false,
    runSSH: false,
    exitNodeID: null,
    autoExitNode: false,    // true when --exit-node=auto:any is active
    accounts: [],
    canControl: true,    // false when access-denied was observed
    // Whether the CLI exists at all. Optimistic by default so a snapshot
    // built from a real `status --json` never has to say so explicitly;
    // only the missing-binary branch of refresh() sets it false.
    installed: true,
    // What this tailnet's ACL allows, straight off the daemon's capability
    // map. Tri-state on purpose: `null` is "the daemon did not say" (too
    // old to publish CapMap, or a status we could not read), which is not
    // the same answer as `false` and must not hide anything.
    taildropAvailable: null,
    funnelsAvailable: null,
    // HTTPS certificates, which Serve over HTTPS (and every funnel) needs.
    httpsAvailable: null,
    error: null,
});

/**
 * Whether the snapshot describes a backend this extension can drive.
 *
 * Two states share that one property, and every surface treats them alike:
 * no CLI to run, and a CLI whose daemon does not answer. `snap.error` with
 * the binary present has exactly two producers (refresh() when the status
 * call fails, and buildSnapshot() when there is no status JSON to build
 * from), and both mean the same thing.
 *
 * What is NOT in here is deliberate. `tailscale down` (backendState
 * "Stopped") and NeedsLogin are answered from inside the menu, by a toggle
 * and a Login button the user would no longer be able to reach.
 *
 * @param {Snapshot} snap
 * @returns {'ready'|'not-installed'|'not-running'}
 */
export function backendStatus(snap) {
    if (snap.installed === false) return 'not-installed';
    if (snap.error) return 'not-running';
    return 'ready';
}

// Tailscale's CLI is annoying: many failure modes (including the operator-
// is-not-set case) exit with code 0 *and* print "Access denied: …" on stderr.
// We treat any output containing this phrase as a failure regardless of code.
export const ACCESS_DENIED_RE = /access denied/i;
export function isAccessDenied(r) {
    return ACCESS_DENIED_RE.test(r.stderr || '') || ACCESS_DENIED_RE.test(r.stdout || '');
}

// Gio.Subprocess.new throws synchronously when the program is not on PATH,
// so spawn() rejects before there is any process to have failed. Every
// caller in this file is written against the {ok, code, stdout, stderr}
// shape and already treats a bad exit as an ordinary failure: hand it one
// rather than let the rejection escape into whichever click handler
// started the command. refresh() has its own, earlier guard; this covers
// the write paths, which are reachable from a keybinding at any moment,
// including the one between the binary going away and the next poll.
export function spawnFailure(e) {
    return { ok: false, code: -1, stdout: '', stderr: String(e?.message ?? e) };
}

function _stripDot(s) {
    return s && s.endsWith('.') ? s.slice(0, -1) : s;
}

// One inbound Taildrop file, read off `tailscale file get --verbose`:
//
//   wrote <sender's name for it> as <absolute path> (<n> bytes)
//
// Deliberately not anchored at the start of the line. The receiver's other
// verbose print, `printf("waiting for file...")`, carries no newline and
// repeats on every poll of --loop, so what read_line() hands back is
//
//   waiting for file...waiting for file...wrote a.txt as /home/me/a.txt (6 bytes)
//
// and the record never begins a line of its own. The trailing size is the
// anchor instead: without it a filename containing " as " would split in
// the wrong place. Anything that doesn't match the whole shape returns
// null rather than a half-parsed path, so a format change upstream cannot
// turn into a bogus path to hand the file manager.
const WROTE_RE = /wrote\s+(.+)\s+as\s+(.+)\s+\((\d+)\s+bytes\)$/;

/**
 * @param {string} line one line of receiver output
 * @returns {{path: string, name: string, size: number}|null}
 */
export function parseWroteLine(line) {
    const m = WROTE_RE.exec((line ?? '').trim());
    if (!m) return null;
    const path = m[2];
    return {
        path,
        // The name on disk, which --conflict=rename often makes differ
        // from the name the sender used.
        name: path.split('/').pop(),
        size: parseInt(m[3], 10),
    };
}

// Anything in AllowedIPs that isn't the peer's own /32 (v4) or /128 (v6) is
// a subnet route the peer advertises (and that we'd accept if --accept-routes).
function _advertisedRoutesOf(rawPeer) {
    const own = new Set();
    for (const ip of rawPeer.TailscaleIPs ?? [])
        own.add(ip.includes(':') ? `${ip}/128` : `${ip}/32`);
    return (rawPeer.AllowedIPs ?? []).filter((c) => !own.has(c));
}

export function peersFromStatus(statusJson, prefs) {
    const peers = [];
    const peerMap = statusJson.Peer ?? {};
    const currentExitID = prefs?.ExitNodeID ?? statusJson.ExitNodeStatus?.ID ?? '';
    for (const key of Object.keys(peerMap)) {
        const p = peerMap[key];
        // Nodes that are only in our netmap so they *can* reach us: Funnel's
        // `funnel-ingress-node` relays are the common case, and a tailnet with
        // Funnel on gains a couple dozen of them. `tailscale status` hides
        // them on the same flag; they are not devices the user owns.
        if (p.ShareeNode) continue;
        // Wireguard sessions the local engine still holds for a node that
        // has left the network map: a device removed from the tailnet, or
        // one whose key rotated. They keep their traffic counters and their
        // last handshake but lose every identifying field, so what reaches
        // the menu is a blank row that cannot be named, copied or routed
        // through, and a peer count one too high. `tailscale status` shows
        // them as `("")`; there is nothing here for the user to act on.
        //
        // Compared against false rather than tested for truth: a daemon old
        // enough not to publish the field at all would otherwise have every
        // one of its peers read as absent from the map, and the list would
        // come back empty.
        if (p.InNetworkMap === false) continue;
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

// Parse `tailscale serve status --json` (a ServeConfig; `funnel status`
// prints the very same document) into what it publishes, one entry per
// thing a visitor can reach: each mount point of an HTTP(S) server, and
// each TCP forwarder. An entry is `public` when its host:port is in the
// flag map, which is what turns a serve into a funnel: the two are one
// config, told apart by that flag alone. The CLI has used both `Funnel`
// and (older) `AllowFunnel` for the flag map; we accept either.
//
// A port the flag map opens but that has nothing behind it is left out.
// That is not hypothetical: `tailscale funnel --tcp=<port> off` removes the
// forwarder and, as of 1.104 (a TODO in its source), leaves the flag set.
// Listing such a port would offer to remove a funnel that serves nothing,
// with a command that fails, and would keep the port from being reused.
//
// Services (`--service`) and foreground sessions live in sub-configs of
// their own and are not read: the extension only ever creates background
// serves on the node itself.
export function parseServeConfig(serveJson) {
    if (!serveJson || typeof serveJson !== 'object') return [];
    const flagMap = serveJson.Funnel ?? serveJson.AllowFunnel ?? {};
    const webMap  = serveJson.Web ?? {};
    const tcpMap  = serveJson.TCP ?? {};
    const hostPort = (key) => {
        const m = /^(.+):(\d+)$/.exec(key);
        return m ? [m[1], parseInt(m[2], 10)] : null;
    };

    // A TCP handler is keyed by port alone, so its host comes from the
    // other two maps: its own port in the flag map first (that is how a
    // TCP funnel is named), then any host at all, since every key of a
    // node's own config names the node.
    const hostOfPort = new Map();
    let anyHost = '';
    for (const key of [...Object.keys(flagMap), ...Object.keys(webMap)]) {
        const hp = hostPort(key);
        if (!hp) continue;
        if (!hostOfPort.has(hp[1])) hostOfPort.set(hp[1], hp[0]);
        anyHost ||= hp[0];
    }

    const out = [];
    for (const [portStr, tcp] of Object.entries(tcpMap)) {
        if (!tcp?.TCPForward) continue;
        const httpsPort = parseInt(portStr, 10);
        const host = hostOfPort.get(httpsPort) ?? anyHost;
        out.push({
            httpsPort, host,
            kind: tcp.TerminateTLS ? 'tls-tcp' : 'tcp',
            path: '',
            handler: 'proxy',
            target: tcp.TCPForward,
            proxyProtocol: tcp.ProxyProtocol || 0,
            public: !!flagMap[`${host}:${portStr}`],
        });
    }

    for (const key of Object.keys(webMap)) {
        const hp = hostPort(key);
        if (!hp) continue;
        const [host, httpsPort] = hp;
        const kind = tcpMap[String(httpsPort)]?.HTTP ? 'http' : 'https';
        const handlers = webMap[key]?.Handlers ?? {};
        for (const path of Object.keys(handlers).sort()) {
            const h = handlers[path] ?? {};
            let handler = 'proxy', target = h.Proxy || '';
            if (!target && h.Path) [handler, target] = ['path', h.Path];
            else if (!target && h.Text) [handler, target] = ['text', h.Text];
            out.push({
                httpsPort, host, kind, path, handler, target,
                proxyProtocol: 0,
                public: !!flagMap[key],
            });
        }
    }
    out.sort((a, b) => a.httpsPort - b.httpsPort ||
        a.path.localeCompare(b.path));
    return out;
}

/** The public half of parseServeConfig(): what Funnel publishes. */
export function parseFunnels(serveJson) {
    return parseServeConfig(serveJson).filter((e) => e.public);
}

/** The tailnet-only half: what Serve shares inside the tailnet. */
export function parseServes(serveJson) {
    return parseServeConfig(serveJson).filter((e) => !e.public);
}

/* -------------------------------------------------------------------------- */
/*                          Serve and Funnel commands                         */
/* -------------------------------------------------------------------------- */

// The flag each kind of entry is addressed by, on the way in and out.
// Funnel takes all but `http`: the internet only reaches it over TLS.
const SERVE_FLAG = Object.freeze({
    'https': 'https',
    'http': 'http',
    'tcp': 'tcp',
    'tls-tcp': 'tls-terminated-tcp',
});

const _isWeb = (kind) => kind === 'https' || kind === 'http';

/**
 * A mount point the way the CLI stores it: "/" when none was given, and a
 * leading slash otherwise. Trailing slashes are kept, as the CLI keeps them
 * (a folder is mounted under "/docs/", say).
 *
 * @param {string} [path]
 * @returns {string}
 */
export function funnelMount(path) {
    const p = (path ?? '').trim();
    if (!p) return '/';
    return p.startsWith('/') ? p : `/${p}`;
}

/**
 * The entry already in the serve config, if any, that a new one would
 * collide with. `entries` is every entry, funnels and serves alike: they
 * share ports.
 *
 *   - A port is public or tailnet-only as a whole (the flag is per
 *     host:port), so a funnel and a serve never share one. Publishing a
 *     funnel next to a tailnet-only mount would put that mount on the
 *     internet; serving next to a funnel would take the funnel down,
 *     since the CLI clears the flag for the port it serves on.
 *   - A TCP forwarder takes its port alone.
 *   - HTTP and HTTPS cannot share a port; two mounts of the same one can,
 *     as long as their paths differ, which is what --set-path is for.
 *
 * @param {Funnel[]} entries
 * @param {{kind: string, httpsPort: number, path?: string, public?: boolean}} spec
 * @returns {Funnel|null}
 */
export function serveClash(entries, { kind, httpsPort, path, public: pub = false }) {
    const mount = funnelMount(path);
    return entries.find((e) => e.httpsPort === httpsPort && (
        !!e.public !== !!pub ||
        !_isWeb(kind) || !_isWeb(e.kind) ||
        e.kind !== kind ||
        e.path === mount)) ?? null;
}

/** serveClash() for a funnel, which is always public. */
export function funnelClash(entries, spec) {
    return serveClash(entries.map((e) => ({ public: true, ...e })),
        { ...spec, public: true });
}

/**
 * Arguments to `tailscale` that publish one entry in the background, with
 * `tailscale serve` or, for a funnel, `tailscale funnel`. Pure, so the
 * vector the extension runs can be read off the tests.
 *
 * @param {{kind?: string, httpsPort: number, target: string, path?: string,
 *          proxyProtocol?: number}} spec
 * @param {{funnel?: boolean}} [opts]
 * @returns {string[]}
 */
export function serveAddArgs(
    { kind = 'https', httpsPort, target, path, proxyProtocol = 0 },
    { funnel = false } = {},
) {
    const args = [funnel ? 'funnel' : 'serve', '--bg', '--yes',
        `--${SERVE_FLAG[kind]}=${httpsPort}`];
    if (_isWeb(kind)) {
        const mount = funnelMount(path);
        if (mount !== '/') args.push(`--set-path=${mount}`);
    } else if (proxyProtocol) {
        args.push(`--proxy-protocol=${proxyProtocol}`);
    }
    args.push(String(target));
    return args;
}

/**
 * Arguments that take exactly one entry down. A web one is named by its
 * mount as well as its port: without --set-path the CLI removes every
 * mount on the port at once.
 *
 * @param {Funnel} e
 * @param {{funnel?: boolean}} [opts]
 * @returns {string[]}
 */
export function serveRemoveArgs(e, { funnel = false } = {}) {
    const kind = SERVE_FLAG[e.kind] ? e.kind : 'https';
    const args = [funnel ? 'funnel' : 'serve',
        `--${SERVE_FLAG[kind]}=${e.httpsPort}`];
    if (_isWeb(kind)) args.push(`--set-path=${funnelMount(e.path)}`);
    args.push('off');
    return args;
}

/** serveAddArgs() for `tailscale funnel`. */
export function funnelAddArgs(spec) {
    return serveAddArgs(spec, { funnel: true });
}

/** serveRemoveArgs() for `tailscale funnel`. */
export function funnelRemoveArgs(f) {
    return serveRemoveArgs(f, { funnel: true });
}

export function buildSnapshot(statusJson, prefsJson, accounts, canControl, funnels, serves = []) {
    if (!statusJson) {
        return {
            ...EMPTY_SNAPSHOT, accounts, canControl, funnels, serves,
            error: 'no-status',
        };
    }
    const self = statusJson.Self ?? {};
    const tailnet = statusJson.CurrentTailnet ?? null;

    // Absent CapMap means the daemon is too old to publish one, not that
    // the tailnet forbids everything, so the answer is "don't know".
    const capMap = self.CapMap ?? null;
    const hasCap = (cap) => capMap
        ? Object.prototype.hasOwnProperty.call(capMap, cap)
        : null;

    const peers = peersFromStatus(statusJson, prefsJson);
    const exitNodes = peers.filter((p) => p.exitNodeOption);
    const currentExitNode = peers.find((p) => p.exitNode) ?? null;

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
        accountName: tailnet?.Name ?? null,
        magicDNSSuffix: statusJson.MagicDNSSuffix || tailnet?.MagicDNSSuffix || null,
        hostname: self.HostName ?? null,
        selfDnsName: _stripDot(self.DNSName ?? '') || null,
        selfIps: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [],
        peers,
        exitNodes,
        currentExitNode,
        advertisedRoutes,
        funnelPorts: _funnelPortsFromCapMap(self.CapMap),
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
        canControl,
        // Reaching this function at all means the CLI ran and answered.
        installed: true,
        taildropAvailable: hasCap(CAP_FILE_SHARING),
        funnelsAvailable: hasCap(CAP_FUNNEL),
        httpsAvailable: hasCap(CAP_HTTPS),
        funnels,
        serves,
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
export function parseSwitchList(text) {
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

/**
 * The same list off the LocalAPI: the two calls `switch --list` itself
 * makes (`GET /localapi/v0/profiles/` and `…/profiles/current`), turned
 * into the rows parseSwitchList reads out of what it prints. The columns
 * are the ones the CLI fills: the profile ID, the tailnet's display name
 * falling back to its domain (NetworkProfile.DisplayNameOrDefault, and
 * just the domain on daemons too old to have a display name), and the
 * profile's name, which is the login.
 *
 * A row the text parser would have dropped for a missing column is
 * dropped here too. One it would have mangled is not: a tailnet whose
 * name holds two spaces in a row splits into extra columns there.
 *
 * @param {object} current LoginProfile
 * @param {object[]} all LoginProfile list
 * @returns {Account[]}
 */
export function accountsFromProfiles(current, all) {
    const accounts = [];
    if (!Array.isArray(all)) return accounts;
    for (const p of all) {
        const id = p?.ID ?? '';
        const net = p?.NetworkProfile ?? {};
        const tailnet = net.DisplayName || net.DomainName || '';
        if (!id || !tailnet) continue;
        accounts.push({
            id,
            tailnet,
            account: p.Name ?? '',
            current: !!current?.ID && id === current.ID,
        });
    }
    return accounts;
}

/* -------------------------------------------------------------------------- */
/*                              IPN bus filter                                */
/* -------------------------------------------------------------------------- */

// Bus message fields that cannot move anything a snapshot holds: wireguard
// counters, Taildrop transfer progress, the daemon's health and version
// news, Taildrive, the suggested exit node, peers' user profiles. Version
// and SessionID ride on messages that carry real news as well, so they
// decide nothing on their own either.
const BUS_IRRELEVANT = new Set([
    'Version', 'SessionID', 'Engine', 'BrowseToURL', 'FilesWaiting',
    'IncomingFiles', 'OutgoingFiles', 'LocalTCPPort', 'ClientVersion',
    'DriveShares', 'Health', 'SuggestedExitNode', 'UserProfiles',
]);

// Fields of a peer patch that no peer row shows. The common ones by far
// are the first three: every peer that roams, re-handshakes or changes
// DERP home sends one, which on a large tailnet is several a minute.
// Online is deliberately not in here, nor CapMap; and a field this list
// does not know is treated as news, as the daemon's own docs ask of
// consumers that meet one.
const PATCH_IRRELEVANT = new Set([
    'NodeID', 'LastSeen', 'Endpoints', 'DERPRegion', 'Key', 'DiscoKey',
    'KeySignature', 'KeyExpiry', 'Cap',
]);

const _present = (v) => v !== null && v !== undefined;

/**
 * Whether one IPN bus message can have changed the snapshot, so that the
 * state behind it is worth reading again.
 *
 * Errs towards yes: anything unrecognised, unparseable or too big to have
 * been decoded counts (`null` is the last of those), and the client's
 * once-a-minute safety poll bounds whatever a wrong no could cost. Only
 * messages made solely of fields known not to matter are dropped.
 *
 * @param {string|null} text one bus line, or null when it was too big
 * @returns {boolean}
 */
export function busMessageMatters(text) {
    if (text === null) return true;
    let msg;
    try {
        msg = JSON.parse(text);
    } catch {
        return true;
    }
    if (!msg || typeof msg !== 'object') return true;
    for (const [key, value] of Object.entries(msg)) {
        if (!_present(value) || BUS_IRRELEVANT.has(key)) continue;
        if (key !== 'PeerChangedPatch') return true;
        if (!Array.isArray(value)) return true;
        for (const patch of value) {
            if (!patch || typeof patch !== 'object') return true;
            for (const [field, v] of Object.entries(patch)) {
                if (_present(v) && !PATCH_IRRELEVANT.has(field)) return true;
            }
        }
    }
    return false;
}

/* -------------------------------------------------------------------------- */
/*                              Equality helper                               */
/* -------------------------------------------------------------------------- */

// Cheap structural compare. Only the fields the UI binds to. Avoids
// re-rendering on every tick when nothing changed.
export function snapshotEqual(a, b) {
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
    if (a.installed !== b.installed) return false;
    if (a.taildropAvailable !== b.taildropAvailable) return false;
    if (a.funnelsAvailable !== b.funnelsAvailable) return false;
    if (a.httpsAvailable !== b.httpsAvailable) return false;
    if ((a.selfDnsName || '') !== (b.selfDnsName || '')) return false;
    if ((a.magicDNSSuffix || '') !== (b.magicDNSSuffix || '')) return false;
    if (a.advertisedRoutes.length !== b.advertisedRoutes.length) return false;
    for (let i = 0; i < a.advertisedRoutes.length; i++) {
        if (a.advertisedRoutes[i].cidr !== b.advertisedRoutes[i].cidr ||
            a.advertisedRoutes[i].peer !== b.advertisedRoutes[i].peer)
            return false;
    }
    if (!_entriesEq(a.funnels, b.funnels)) return false;
    if (!_entriesEq(a.serves ?? [], b.serves ?? [])) return false;
    if ((a.error || null) !== (b.error || null)) return false;
    if (!_arrEq(a.selfIps, b.selfIps)) return false;
    if (!_arrEq(a.funnelPorts, b.funnelPorts)) return false;
    if (a.peers.length !== b.peers.length) return false;
    for (let i = 0; i < a.peers.length; i++) {
        const p = a.peers[i];
        const q = b.peers[i];
        if (
            p.id !== q.id ||
            p.hostname !== q.hostname ||
            // Both are on screen: dnsName is the peer row's title whenever
            // the host has no name of its own, and also keys the copy
            // chooser; os is the second half of its subtitle.
            p.dnsName !== q.dnsName ||
            p.os !== q.os ||
            p.online !== q.online ||
            // `active` is left out on purpose: nothing renders it, and it
            // flips whenever traffic to a peer starts or stops, so counting
            // it would rebuild the whole menu for a change no one can see.
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
        // tailnet before account: it is what labels the row and the submenu
        // header, so a tailnet renamed in the admin console has to land.
        if (x.id !== y.id || x.tailnet !== y.tailnet ||
            x.account !== y.account || x.current !== y.current)
            return false;
    }
    return true;
}

function _entriesEq(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const x = a[i], y = b[i];
        if (x.httpsPort !== y.httpsPort || x.target !== y.target ||
            x.host !== y.host || x.kind !== y.kind || x.path !== y.path ||
            x.handler !== y.handler || x.proxyProtocol !== y.proxyProtocol ||
            !!x.public !== !!y.public)
            return false;
    }
    return true;
}

function _arrEq(a, b) {
    if (a === b) return true;
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}
