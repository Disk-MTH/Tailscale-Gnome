// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// Snapshot parsing rules that don't need a live GNOME Shell session.

import GLib from 'gi://GLib';

import { assertEq, assertDeepEq, assertTrue, suite, test } from './harness.js';
import { TailscaleClient } from '../lib/tailscale.js';
import {
    accountsFromProfiles, backendStatus, buildSnapshot, busMessageMatters,
    funnelAddArgs, funnelClash, funnelMount, funnelRemoveArgs, parseFunnels,
    parseServeConfig, parseServes, parseSwitchList, parseWroteLine,
    peersFromStatus, serveAddArgs, serveClash, serveRemoveArgs,
} from '../lib/tailscale-parse.js';

// Enabling Funnel makes the control plane push its ingress relays into our
// netmap. They are flagged `ShareeNode` precisely so clients hide them, and
// `tailscale status` skips them for the same reason.
const FUNNEL_INGRESS = {
    ID: 'ntUjTr6YFk11CNTRL',
    HostName: 'funnel-ingress-node',
    DNSName: '',
    OS: '',
    Tags: ['tag:ingress'],
    TailscaleIPs: ['fd7a:115c:a1e0::a801:26ab'],
    AllowedIPs: ['fd7a:115c:a1e0::a801:26ab/128'],
    Online: true,
    ShareeNode: true,
};

const REAL_PEER = {
    ID: 'n6jzEBZCVi11CNTRL',
    HostName: 'redmi-disk-mth',
    DNSName: 'redmi-disk-mth.tail412bcc.ts.net.',
    OS: 'android',
    TailscaleIPs: ['100.102.193.116'],
    AllowedIPs: ['100.102.193.116/32'],
    Online: true,
};

// A wireguard session the local engine still holds for a node that has
// left the network map: a device removed from the tailnet, or one whose
// key rotated. Copied from a real `status --json`, where it sits beside
// the two devices this tailnet actually has. It carries traffic counters
// and a recent handshake but no identity at all, and `tailscale status`
// prints it as `("")`.
const STALE_ENGINE_PEER = {
    ID: '',
    HostName: '',
    DNSName: '',
    OS: '',
    TailscaleIPs: null,
    Online: false,
    InEngine: true,
    InNetworkMap: false,
};

suite('peersFromStatus', () => {
    test('hides a wireguard session that left the network map', () => {
        const peers = peersFromStatus({
            Peer: {
                'nodekey:aaa': STALE_ENGINE_PEER,
                'nodekey:bbb': REAL_PEER,
            },
        }, null);
        assertEq(peers.length, 1, 'the nameless engine peer is not a device');
        assertEq(peers[0].hostname, 'redmi-disk-mth');
    });

    test('a daemon that reports no InNetworkMap keeps its peers', () => {
        // The field is absent, not false. Treating "don't know" as "not in
        // the map" would empty the peer list on any daemon old enough not
        // to publish it.
        const peers = peersFromStatus({
            Peer: { 'nodekey:bbb': REAL_PEER },
        }, null);
        assertEq(peers.length, 1);
    });

    test('hides funnel ingress relays', () => {
        const peers = peersFromStatus({
            Peer: {
                'nodekey:aaa': FUNNEL_INGRESS,
                'nodekey:bbb': REAL_PEER,
                'nodekey:ccc': { ...FUNNEL_INGRESS, ID: 'nTHnBkfDVn11CNTRL' },
            },
        }, null);
        assertEq(peers.length, 1, 'only the real device survives');
        assertEq(peers[0].hostname, 'redmi-disk-mth');
    });

    test('keeps real peers and strips the trailing DNS dot', () => {
        const peers = peersFromStatus({ Peer: { 'nodekey:bbb': REAL_PEER } }, null);
        assertEq(peers[0].dnsName, 'redmi-disk-mth.tail412bcc.ts.net');
        assertDeepEq(peers[0].ips, ['100.102.193.116']);
    });

    test('sorts by hostname, case-insensitively', () => {
        const peers = peersFromStatus({
            Peer: {
                a: { ...REAL_PEER, ID: 'a', HostName: 'zebra' },
                b: { ...REAL_PEER, ID: 'b', HostName: 'Alpha' },
            },
        }, null);
        assertDeepEq(peers.map((p) => p.hostname), ['Alpha', 'zebra']);
    });

    test('reports subnet routes but not the peer own address', () => {
        const peers = peersFromStatus({
            Peer: {
                a: {
                    ...REAL_PEER,
                    AllowedIPs: ['100.102.193.116/32', '192.168.1.0/24'],
                },
            },
        }, null);
        assertDeepEq(peers[0].advertisedRoutes, ['192.168.1.0/24']);
    });

    test('marks the selected exit node from prefs', () => {

        const peers = peersFromStatus(
            { Peer: { a: { ...REAL_PEER, ExitNodeOption: true } } },
            { ExitNodeID: REAL_PEER.ID },
        );
        assertEq(peers[0].exitNode, true);
    });
});

// `tailscale file get --verbose` announces each inbound file on stdout as
//   wrote <sender's name for it> as <absolute path> (<n> bytes)
// (cmd/tailscale/cli/file.go). The path is what the notification needs in
// order to open the file manager where the file actually landed.
suite('parseWroteLine', () => {
    test('splits the original name, the landing path and the size', () => {
        const r = parseWroteLine(
            'wrote rapport.pdf as /home/me/Downloads/rapport.pdf (1234 bytes)');
        assertEq(r.path, '/home/me/Downloads/rapport.pdf');
        assertEq(r.name, 'rapport.pdf');
        assertEq(r.size, 1234);
    });

    test('reports the landing name, not the sender name', () => {
        // --conflict=rename is what the receiver runs with, so the file on
        // disk is frequently not the name the sender used.
        const r = parseWroteLine(
            'wrote notes.txt as /home/me/Downloads/notes (2).txt (7 bytes)');
        assertEq(r.name, 'notes (2).txt');
        assertEq(r.path, '/home/me/Downloads/notes (2).txt');
    });

    test('keeps spaces and parentheses inside the path', () => {
        const r = parseWroteLine(
            'wrote a b.zip as /home/me/My Files (old)/a b.zip (99 bytes)');
        assertEq(r.path, '/home/me/My Files (old)/a b.zip');
        assertEq(r.size, 99);
    });

    test('finds the record after the pollster noise', () => {
        // `printf("waiting for file...")` carries no newline and repeats on
        // every poll of --loop, so the record never starts its own line.
        const r = parseWroteLine(
            'waiting for file...waiting for file...wrote a.txt as /home/me/a.txt (6 bytes)');
        assertEq(r.path, '/home/me/a.txt');
        assertEq(r.name, 'a.txt');
        assertEq(r.size, 6);
    });

    test('ignores the receiver other verbose lines', () => {
        assertEq(parseWroteLine('waiting for file...'), null);
        assertEq(parseWroteLine('moved 1/1 files'), null);
        assertEq(parseWroteLine(''), null);
    });

    test('ignores a wrote line it cannot fully account for', () => {
        // Rather than half-parse a format change into a broken path.
        assertEq(parseWroteLine('wrote something unexpected'), null);
    });
});

suite('TailscaleClient: no CLI on PATH', () => {
    // find_program_in_path reads PATH out of the environment, so PATH is
    // the whole fixture: point it at a directory holding an executable
    // called `tailscale` for the installed case, and at an empty one for
    // the other. Restored on every exit path: a leaked PATH would take
    // the rest of this file down with it and give no clue why.
    function withPath(value, fn) {
        const saved = GLib.getenv('PATH');
        GLib.setenv('PATH', value, true);
        try {
            return fn();
        } finally {
            GLib.setenv('PATH', saved ?? '', true);
        }
    }

    // Two directories under one temp root: `bin` with the stub, `empty`
    // without. Built once: nothing here writes to them.
    const root = GLib.dir_make_tmp('tailscale-gnome-test-XXXXXX');
    const binDir = GLib.build_filenamev([root, 'bin']);
    const emptyDir = GLib.build_filenamev([root, 'empty']);
    GLib.mkdir_with_parents(binDir, 0o755);
    GLib.mkdir_with_parents(emptyDir, 0o755);
    const stub = GLib.build_filenamev([binDir, 'tailscale']);
    GLib.file_set_contents(stub, '#!/bin/sh\nexit 0\n');
    // Executable, because that is what find_program_in_path checks for;
    // a readable file of the right name is not a hit.
    GLib.chmod(stub, 0o755);

    // The toggle renders from this very snapshot before the first poll
    // lands. An optimistic default would show a working-but-disconnected
    // Tailscale for as long as that takes.
    test('the first snapshot says so before any poll has run', () => {
        withPath(emptyDir, () => {
            const c = new TailscaleClient();
            assertEq(c.snapshot.installed, false);
            assertEq(c.snapshot.running, false);
            assertTrue(typeof c.snapshot.error === 'string');
            c.destroy();
        });
    });

    test('a CLI on PATH is not reported as missing', () => {
        withPath(binDir, () => {
            const c = new TailscaleClient();
            assertEq(c.snapshot.installed, true);
            assertEq(c.snapshot.error, null);
            c.destroy();
        });
    });

    // The transition is the event; the state is not. Every poll after the
    // binary goes lands in the same place and must stay silent, or the
    // user gets a banner every few seconds for the rest of the session.
    test('settling into the missing state emits exactly once', () => {
        withPath(binDir, () => {
            const c = new TailscaleClient();
            let emissions = 0;
            c.connect('state-changed', () => emissions++);
            c._goMissing();
            c._goMissing();
            c._goMissing();
            assertEq(emissions, 1);
            assertEq(c.snapshot.installed, false);
            c.destroy();
        });
    });
});

suite('backendStatus', () => {
    test('a missing binary outranks the error it sets', () => {
        assertEq(backendStatus({
            installed: false,
            error: 'tailscale: not found in PATH',
        }), 'not-installed');
    });

    test('an unreadable status is a daemon we cannot drive', () => {
        assertEq(backendStatus({ installed: true, error: 'no-status' }),
            'not-running');
    });

    test('a stderr line from a failed poll says the same thing', () => {
        assertEq(backendStatus({
            installed: true,
            error: 'failed to connect to local tailscaled',
        }), 'not-running');
    });

    test('a healthy snapshot is ready', () => {
        assertEq(backendStatus({ installed: true, error: null }), 'ready');
    });

    // The two states the gate must NOT catch: both are answered from
    // inside the menu, by a toggle and a Login button the user would no
    // longer be able to reach.
    test('`tailscale down` is still ready', () => {
        assertEq(backendStatus({
            installed: true,
            error: null,
            backendState: 'Stopped',
            running: false,
        }), 'ready');
    });

    test('NeedsLogin is still ready', () => {
        assertEq(backendStatus({
            installed: true,
            error: null,
            backendState: 'NeedsLogin',
            loggedOut: true,
        }), 'ready');
    });
});

// The LocalAPI's profile list has to land on the same rows `switch --list`
// prints, since the menu cannot tell which of the two it came from.
suite('accountsFromProfiles', () => {
    const work = {
        ID: '13ee', Name: 'me@example.com',
        NetworkProfile: { DomainName: 'corp.example', DisplayName: 'Corp' },
    };
    const own = {
        ID: '3c95', Name: 'me@example.com',
        NetworkProfile: { DomainName: 'me@example.com' },
    };

    test('the rows the CLI prints for the same profiles', () => {
        const cli = parseSwitchList(
            'ID    Tailnet          Account\n' +
            '13ee  Corp             me@example.com*\n' +
            '3c95  me@example.com   me@example.com\n');
        assertDeepEq(accountsFromProfiles(work, [work, own]), cli);
    });

    test('the domain stands in for a missing display name', () => {
        assertEq(accountsFromProfiles(null, [own])[0].tailnet, 'me@example.com');
    });

    test('no current profile marks none', () => {
        const rows = accountsFromProfiles({}, [work, own]);
        assertTrue(rows.every((a) => !a.current));
    });

    test('a profile with no tailnet yet is left out, as by the CLI', () => {
        assertDeepEq(accountsFromProfiles(null, [{ ID: 'x', Name: 'n' }]), []);
    });

    test('anything but a list is no profiles', () => {
        assertDeepEq(accountsFromProfiles(null, null), []);
        assertDeepEq(accountsFromProfiles(null, {}), []);
    });

    // The text parser splits on runs of two spaces; JSON has no such trap.
    test('a tailnet name with two spaces survives', () => {
        const odd = { ID: 'a', Name: 'me', NetworkProfile: { DisplayName: 'My  Net' } };
        assertEq(accountsFromProfiles(odd, [odd])[0].tailnet, 'My  Net');
    });
});

// What is worth a re-read of the daemon's state. Wrongly dropping a message
// costs up to a minute of staleness; wrongly keeping one costs a read. So
// the tests below pin the drops, and everything else must stay a yes.
suite('busMessageMatters', () => {
    const msg = (o) => JSON.stringify({ Version: '1.104.2', ErrMessage: null, ...o });

    test('state, prefs, our own node, peers coming and going: yes', () => {
        assertTrue(busMessageMatters(msg({ State: 6 })));
        assertTrue(busMessageMatters(msg({ Prefs: { WantRunning: true } })));
        assertTrue(busMessageMatters(msg({ SelfChange: { ID: 1 } })));
        assertTrue(busMessageMatters(msg({ PeersChanged: [{ ID: 2 }] })));
        assertTrue(busMessageMatters(msg({ PeersRemoved: [2] })));
        assertTrue(busMessageMatters(msg({ LoginFinished: {} })));
        assertTrue(busMessageMatters(msg({ ErrMessage: 'boom' })));
    });

    test('a peer going on or offline: yes, offline included', () => {
        assertTrue(busMessageMatters(msg({ PeerChangedPatch: [{ NodeID: 2, Online: true }] })));
        assertTrue(busMessageMatters(msg({ PeerChangedPatch: [{ NodeID: 2, Online: false }] })));
    });

    test('peers roaming and re-handshaking: no', () => {
        assertEq(busMessageMatters(msg({
            PeerChangedPatch: [
                { NodeID: 2, LastSeen: '2026-10-25T12:00:00Z' },
                { NodeID: 3, Endpoints: ['1.2.3.4:41641'], DERPRegion: 4 },
            ],
        })), false);
    });

    test('one patch that matters in a batch of noise: yes', () => {
        assertTrue(busMessageMatters(msg({
            PeerChangedPatch: [
                { NodeID: 2, LastSeen: '2026-10-25T12:00:00Z' },
                { NodeID: 3, Online: true },
            ],
        })));
    });

    test('a patch field nobody knows yet: yes', () => {
        assertTrue(busMessageMatters(msg({ PeerChangedPatch: [{ NodeID: 2, Shiny: 1 }] })));
    });

    test('health, transfers, version news on their own: no', () => {
        assertEq(busMessageMatters(msg({ Health: { Warnings: {} } })), false);
        assertEq(busMessageMatters(msg({ IncomingFiles: [{ Name: 'a' }] })), false);
        assertEq(busMessageMatters(msg({ ClientVersion: { RunningLatest: true } })), false);
        assertEq(busMessageMatters(msg({})), false, 'just the version');
    });

    test('a field nobody knows yet: yes', () => {
        assertTrue(busMessageMatters(msg({ SomethingNew: { a: 1 } })));
    });

    test('a network map too big to decode, or garbage: yes', () => {
        assertTrue(busMessageMatters(null));
        assertTrue(busMessageMatters('{not json'));
        assertTrue(busMessageMatters('42'));
    });
});

// A serve config with one of everything Funnel can publish, shaped after
// ipn.ServeConfig: TCP keyed by port, Web by host:port, Handlers by mount.
const SERVE = {
    TCP: {
        443: { HTTPS: true },
        8443: { TCPForward: '127.0.0.1:5432', ProxyProtocol: 2 },
        10000: { TCPForward: '127.0.0.1:22', TerminateTLS: 'box.ts.net' },
    },
    Web: {
        'box.ts.net:443': {
            Handlers: {
                '/': { Proxy: 'http://127.0.0.1:3000' },
                '/docs/': { Path: '/srv/docs' },
                '/hi': { Text: 'Hello' },
            },
        },
    },
    AllowFunnel: {
        'box.ts.net:443': true,
        'box.ts.net:8443': true,
        'box.ts.net:10000': true,
        // What `funnel --tcp=… off` leaves behind: the flag, no handler.
        'box.ts.net:9999': true,
    },
};

suite('parseFunnels', () => {
    const funnels = parseFunnels(SERVE);

    test('one entry per HTTPS mount, sorted by port then path', () => {
        const https = funnels.filter((f) => f.kind === 'https');
        assertDeepEq(https.map((f) => [f.path, f.handler, f.target]), [
            ['/', 'proxy', 'http://127.0.0.1:3000'],
            ['/docs/', 'path', '/srv/docs'],
            ['/hi', 'text', 'Hello'],
        ]);
        assertTrue(https.every((f) => f.httpsPort === 443 && f.host === 'box.ts.net'));
    });

    test('a TCP forwarder, with its PROXY protocol', () => {
        const f = funnels.find((x) => x.httpsPort === 8443);
        assertEq(f.kind, 'tcp');
        assertEq(f.target, '127.0.0.1:5432');
        assertEq(f.proxyProtocol, 2);
        assertEq(f.path, '');
    });

    test('a TLS-terminated one', () => {
        const f = funnels.find((x) => x.httpsPort === 10000);
        assertEq(f.kind, 'tls-tcp');
        assertEq(f.target, '127.0.0.1:22');
    });

    test('a port the flag opens with nothing behind it is not a funnel', () => {
        assertTrue(!funnels.some((f) => f.httpsPort === 9999));
    });

    test('a port served but not opened to the internet is not one either', () => {
        const closed = { ...SERVE, AllowFunnel: { 'box.ts.net:443': false } };
        assertDeepEq(parseFunnels(closed), []);
    });

    test('no config at all is no funnels', () => {
        assertDeepEq(parseFunnels(null), []);
        assertDeepEq(parseFunnels({}), []);
    });
});

suite('funnel commands', () => {
    test('the plain HTTPS case is the command 1.1.0 ran', () => {
        assertDeepEq(funnelAddArgs({ httpsPort: 443, target: '3000' }),
            ['funnel', '--bg', '--yes', '--https=443', '3000']);
    });

    test('a path becomes --set-path, "/" is the default and left out', () => {
        assertDeepEq(
            funnelAddArgs({ kind: 'https', httpsPort: 8443, target: '3000', path: 'api' }),
            ['funnel', '--bg', '--yes', '--https=8443', '--set-path=/api', '3000']);
        assertDeepEq(
            funnelAddArgs({ kind: 'https', httpsPort: 443, target: '3000', path: '/' }),
            ['funnel', '--bg', '--yes', '--https=443', '3000']);
    });

    test('TCP kinds take --proxy-protocol, never --set-path', () => {
        assertDeepEq(
            funnelAddArgs({ kind: 'tcp', httpsPort: 10000, target: '5432', path: '/x', proxyProtocol: 2 }),
            ['funnel', '--bg', '--yes', '--tcp=10000', '--proxy-protocol=2', '5432']);
        assertDeepEq(
            funnelAddArgs({ kind: 'tls-tcp', httpsPort: 8443, target: 'unix:/run/x.sock' }),
            ['funnel', '--bg', '--yes', '--tls-terminated-tcp=8443', 'unix:/run/x.sock']);
    });

    test('text with spaces stays one argument', () => {
        const args = funnelAddArgs({ httpsPort: 443, target: 'text:Hello world' });
        assertEq(args[args.length - 1], 'text:Hello world');
    });

    test('removal names exactly one funnel', () => {
        const [root, docs] = parseFunnels(SERVE);
        assertDeepEq(funnelRemoveArgs(root), ['funnel', '--https=443', '--set-path=/', 'off']);
        assertDeepEq(funnelRemoveArgs(docs), ['funnel', '--https=443', '--set-path=/docs/', 'off']);
        assertDeepEq(funnelRemoveArgs({ kind: 'tcp', httpsPort: 8443 }),
            ['funnel', '--tcp=8443', 'off']);
        assertDeepEq(funnelRemoveArgs({ kind: 'tls-tcp', httpsPort: 10000 }),
            ['funnel', '--tls-terminated-tcp=10000', 'off']);
    });

    test('mount points', () => {
        assertEq(funnelMount(''), '/');
        assertEq(funnelMount('  '), '/');
        assertEq(funnelMount('api'), '/api');
        assertEq(funnelMount('/docs/'), '/docs/');
    });
});

suite('funnelClash', () => {
    const funnels = parseFunnels(SERVE);

    test('an HTTPS mount can join a port under a new path', () => {
        assertEq(funnelClash(funnels, { kind: 'https', httpsPort: 443, path: '/new' }), null);
    });

    test('but not under one already served', () => {
        assertTrue(funnelClash(funnels, { kind: 'https', httpsPort: 443, path: '' }) !== null);
        assertTrue(funnelClash(funnels, { kind: 'https', httpsPort: 443, path: 'hi' }) !== null);
    });

    test('HTTPS and TCP never share a port', () => {
        assertTrue(funnelClash(funnels, { kind: 'https', httpsPort: 8443, path: '/x' }) !== null);
        assertTrue(funnelClash(funnels, { kind: 'tcp', httpsPort: 443 }) !== null);
    });

    test('a free port is free for every kind', () => {
        for (const kind of ['https', 'tcp', 'tls-tcp'])
            assertEq(funnelClash(funnels, { kind, httpsPort: 9999 }), null);
    });
});

// One config, both features: a funnel on 443, and inside the tailnet an
// HTTP server on 80 with two mounts, a raw TCP forwarder on 5432 and an
// HTTPS one on 8443. Only the flag map tells the public part apart.
const MIXED = {
    TCP: {
        443: { HTTPS: true },
        80: { HTTP: true },
        8443: { HTTPS: true },
        5432: { TCPForward: '127.0.0.1:5432' },
    },
    Web: {
        'box.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } },
        'box.ts.net:80': {
            Handlers: {
                '/': { Proxy: 'http://127.0.0.1:8080' },
                '/files/': { Path: '/srv/files' },
            },
        },
        'box.ts.net:8443': { Handlers: { '/': { Proxy: 'https+insecure://localhost:9443' } } },
    },
    AllowFunnel: { 'box.ts.net:443': true },
};

suite('parseServeConfig: Funnel and Serve in one document', () => {
    const all = parseServeConfig(MIXED);

    test('the flag map alone decides what is public', () => {
        assertDeepEq(parseFunnels(MIXED).map((e) => e.httpsPort), [443]);
        assertDeepEq(parseServes(MIXED).map((e) => [e.httpsPort, e.path]),
            [[80, '/'], [80, '/files/'], [5432, ''], [8443, '/']]);
        assertTrue(all.every((e) => e.public === (e.httpsPort === 443)));
    });

    test('HTTP is told from HTTPS by the port\'s own flag', () => {
        const kinds = Object.fromEntries(all.map((e) => [e.httpsPort, e.kind]));
        assertEq(kinds[80], 'http');
        assertEq(kinds[8443], 'https');
        assertEq(kinds[5432], 'tcp');
    });

    test('a TCP forwarder borrows its host from the rest of the config', () => {
        assertEq(all.find((e) => e.httpsPort === 5432).host, 'box.ts.net');
    });

    test('a TCP forwarder alone in the config has no host to name', () => {
        const lone = parseServeConfig({ TCP: { 22: { TCPForward: '127.0.0.1:22' } } });
        assertEq(lone.length, 1);
        assertEq(lone[0].host, '');
        assertEq(lone[0].public, false);
    });
});

suite('serveClash', () => {
    const all = parseServeConfig(MIXED);

    test('Serve never lands on a funnel\'s port, nor Funnel on a served one', () => {
        // Serving would take the funnel down; publishing would put the
        // tailnet-only mounts on the internet.
        assertTrue(serveClash(all, { kind: 'https', httpsPort: 443, path: '/x' }) !== null);
        assertTrue(funnelClash(all, { kind: 'https', httpsPort: 8443, path: '/x' }) !== null);
    });

    test('a new path joins a served port of the same scheme', () => {
        assertEq(serveClash(all, { kind: 'http', httpsPort: 80, path: '/api' }), null);
    });

    test('but HTTP and HTTPS never share one', () => {
        assertTrue(serveClash(all, { kind: 'https', httpsPort: 80, path: '/api' }) !== null);
    });

    test('a TCP forwarder takes its port alone', () => {
        assertTrue(serveClash(all, { kind: 'tcp', httpsPort: 80 }) !== null);
        assertTrue(serveClash(all, { kind: 'http', httpsPort: 5432 }) !== null);
    });

    test('any other port is free', () => {
        assertEq(serveClash(all, { kind: 'tcp', httpsPort: 2222 }), null);
    });
});

suite('serve commands', () => {
    test('the plain case: HTTPS on 443, in the background', () => {
        assertDeepEq(serveAddArgs({ httpsPort: 443, target: '3000' }),
            ['serve', '--bg', '--yes', '--https=443', '3000']);
    });

    test('HTTP, with a path', () => {
        assertDeepEq(
            serveAddArgs({ kind: 'http', httpsPort: 8080, target: '3000', path: 'app' }),
            ['serve', '--bg', '--yes', '--http=8080', '--set-path=/app', '3000']);
    });

    test('TCP with PROXY protocol', () => {
        assertDeepEq(
            serveAddArgs({ kind: 'tcp', httpsPort: 5432, target: '5432', proxyProtocol: 1 }),
            ['serve', '--bg', '--yes', '--tcp=5432', '--proxy-protocol=1', '5432']);
    });

    test('removal goes through `serve`, by port and mount', () => {
        const [http] = parseServes(MIXED);
        assertDeepEq(serveRemoveArgs(http), ['serve', '--http=80', '--set-path=/', 'off']);
        assertDeepEq(serveRemoveArgs({ kind: 'tcp', httpsPort: 5432 }),
            ['serve', '--tcp=5432', 'off']);
    });

    test('the funnel wrappers are the same vectors under `funnel`', () => {
        const spec = { kind: 'tcp', httpsPort: 10000, target: '22' };
        assertDeepEq(funnelAddArgs(spec).slice(1), serveAddArgs(spec).slice(1));
        assertEq(funnelAddArgs(spec)[0], 'funnel');
        assertEq(funnelRemoveArgs(spec)[0], 'funnel');
    });
});

suite('buildSnapshot: what Serve needs from the status', () => {
    const status = {
        BackendState: 'Running',
        Self: { HostName: 'box', DNSName: 'box.ts.net.', CapMap: { https: null } },
    };

    test('HTTPS certificates and our own DNS name', () => {
        const snap = buildSnapshot(status, {}, [], true, [], parseServes(MIXED));
        assertEq(snap.httpsAvailable, true);
        assertEq(snap.selfDnsName, 'box.ts.net');
        assertEq(snap.serves.length, 4);
    });

    test('no certificates is a no, no CapMap is a don\'t know', () => {
        const without = { ...status, Self: { ...status.Self, CapMap: {} } };
        assertEq(buildSnapshot(without, {}, [], true, []).httpsAvailable, false);
        const old = { ...status, Self: { HostName: 'box' } };
        assertEq(buildSnapshot(old, {}, [], true, []).httpsAvailable, null);
    });
});
