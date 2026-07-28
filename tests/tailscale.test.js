// Snapshot parsing rules that don't need a live GNOME Shell session.

import { assertEq, assertDeepEq, suite, test } from './harness.js';
import { peersFromStatus } from '../lib/tailscale.js';

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
