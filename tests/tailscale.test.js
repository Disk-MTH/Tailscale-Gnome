// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// Snapshot parsing rules that don't need a live GNOME Shell session.

import GLib from 'gi://GLib';

import { assertEq, assertDeepEq, assertTrue, suite, test } from './harness.js';
import {
    TailscaleClient, backendStatus, parseWroteLine, peersFromStatus,
} from '../lib/tailscale.js';

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

suite('peersFromStatus', () => {
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
