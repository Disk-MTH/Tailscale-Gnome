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

import { CAP_FILE_SHARING, CAP_FUNNEL } from './util.js';

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
 * @property {number}  httpsPort       Public port (443 | 8443 | 10000)
 * @property {string}  target          Proxied local target, if any
 * @property {string}  host            Public hostname serving it
 *
 * @typedef {object} Snapshot
 * @property {string}  backendState    e.g. "Running" | "Stopped" | "NeedsLogin" | …
 * @property {boolean} running         backendState === "Running"
 * @property {boolean} loggedOut
 * @property {string|null} accountName Display name of the current tailnet
 * @property {string|null} magicDNSSuffix
 * @property {string|null} hostname    Self.HostName
 * @property {string[]} selfIps        Self.TailscaleIPs
 * @property {Peer[]}  peers           All peers, sorted by hostname
 * @property {Peer[]}  exitNodes       Subset advertising exit-node service
 * @property {Peer|null} currentExitNode
 * @property {Route[]} advertisedRoutes
 * @property {Funnel[]} funnels
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
    funnels: [],            // [{ httpsPort, target, host }, …]
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
export function parseFunnels(serveJson) {
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

export function buildSnapshot(statusJson, prefsJson, accounts, canControl, funnels) {
    if (!statusJson) {
        return { ...EMPTY_SNAPSHOT, accounts, canControl, funnels, error: 'no-status' };
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
        // tailnet before account: it is what labels the row and the submenu
        // header, so a tailnet renamed in the admin console has to land.
        if (x.id !== y.id || x.tailnet !== y.tailnet ||
            x.account !== y.account || x.current !== y.current)
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
