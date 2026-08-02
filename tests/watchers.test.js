// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

import { suite, test, assertEq, assertDeepEq } from './harness.js';
import { EMPTY_TRACK, computeEvents, SnapshotWatcher } from '../lib/watchers.js';

const node = (over = {}) => ({
    id: 'n1', hostname: 'paris', dnsName: 'paris.tail.ts.net',
    online: true, exitNodeOption: true, ...over,
});

const snapshot = (over = {}) => ({
    backendState: 'Running',
    exitNodeID: null,
    autoExitNode: false,
    currentExitNode: null,
    accountName: null,
    ...over,
});

const types = (events) => events.map(e => e.type);

// Seeds the tracker so exit-node comparisons have a baseline, the way the
// first render does at runtime.
const seed = (snap) => computeEvents(EMPTY_TRACK, snap).track;

suite('computeEvents — connection', () => {
    test('entering Starting opens a pending event', () => {
        const { events } = computeEvents(EMPTY_TRACK, snapshot({ backendState: 'Starting' }));
        assertDeepEq(types(events), ['connection-starting']);
        assertEq(events[0].level, 'pending');
        assertEq(events[0].category, 'connection');
    });

    test('Starting to Running resolves as established', () => {
        const t = computeEvents(EMPTY_TRACK, snapshot({ backendState: 'Starting' })).track;
        const { events } = computeEvents(t, snapshot({ backendState: 'Running' }));
        assertDeepEq(types(events), ['connection-established']);
        assertEq(events[0].level, 'success');
    });

    test('Starting to anything else resolves as ended', () => {
        const t = computeEvents(EMPTY_TRACK, snapshot({ backendState: 'Starting' })).track;
        const { events } = computeEvents(t, snapshot({ backendState: 'Stopped' }));
        assertDeepEq(types(events), ['connection-ended']);
        assertEq(events[0].data.backendState, 'Stopped');
    });

    test('reaching Running without a Starting phase is silent', () => {
        const t = computeEvents(EMPTY_TRACK, snapshot({ backendState: 'Stopped' })).track;
        const { events } = computeEvents(t, snapshot({ backendState: 'Running' }));
        assertDeepEq(types(events), []);
    });

    test('an unchanged backendState emits nothing', () => {
        const t = seed(snapshot());
        const { events } = computeEvents(t, snapshot());
        assertDeepEq(types(events), []);
    });

    test('unchanged backendState while pending does not block later resolution', () => {
        const t1 = computeEvents(EMPTY_TRACK, snapshot({ backendState: 'Starting' })).track;
        const t2 = computeEvents(t1, snapshot({ backendState: 'Starting' })).track;
        const { events } = computeEvents(t2, snapshot({ backendState: 'Running' }));
        assertDeepEq(types(events), ['connection-established']);
    });
});

suite('computeEvents — exit node, auto mode', () => {
    const auto = (over = {}) => snapshot({ autoExitNode: true, ...over });

    test('losing the picked node warns', () => {
        const t = seed(auto({ currentExitNode: node() }));
        const { events } = computeEvents(t, auto({ currentExitNode: node({ online: false }) }));
        assertDeepEq(types(events), ['exit-node-lost']);
        assertEq(events[0].level, 'warning');
    });

    test('acquiring a node reports its name', () => {
        const t = seed(auto({ currentExitNode: null }));
        const { events } = computeEvents(t, auto({ currentExitNode: node() }));
        assertDeepEq(types(events), ['exit-node-acquired']);
        assertEq(events[0].data.name, 'paris');
    });

    test('switching between two routable nodes reports the new one', () => {
        const t = seed(auto({ currentExitNode: node() }));
        const next = node({ id: 'n2', hostname: 'lyon' });
        const { events } = computeEvents(t, auto({ currentExitNode: next }));
        assertDeepEq(types(events), ['exit-node-switched']);
        assertEq(events[0].data.name, 'lyon');
    });

    test('a node still advertising but offline counts as lost', () => {
        const t = seed(auto({ currentExitNode: node() }));
        const { events } = computeEvents(t, auto({ currentExitNode: node({ exitNodeOption: false }) }));
        assertDeepEq(types(events), ['exit-node-lost']);
    });
});

suite('computeEvents — exit node, pinned mode', () => {
    const pinned = (over = {}) => snapshot({ exitNodeID: 'n1', ...over });

    test('going offline then back online round-trips', () => {
        const t0 = seed(pinned({ currentExitNode: node() }));
        const down = computeEvents(t0, pinned({ currentExitNode: node({ online: false }) }));
        assertDeepEq(types(down.events), ['exit-node-offline']);
        assertEq(down.events[0].data.name, 'paris');

        const up = computeEvents(down.track, pinned({ currentExitNode: node() }));
        assertDeepEq(types(up.events), ['exit-node-online']);
    });

    test('losing then regaining the exit advertisement round-trips', () => {
        const t0 = seed(pinned({ currentExitNode: node() }));
        const off = computeEvents(t0, pinned({ currentExitNode: node({ exitNodeOption: false }) }));
        assertDeepEq(types(off.events), ['exit-node-disabled']);

        const on = computeEvents(off.track, pinned({ currentExitNode: node() }));
        assertDeepEq(types(on.events), ['exit-node-reenabled']);
    });

    test('changing the pinned target emits nothing — the user did that', () => {
        const t = seed(pinned({ currentExitNode: node() }));
        const { events } = computeEvents(t, snapshot({
            exitNodeID: 'n2', currentExitNode: node({ id: 'n2', hostname: 'lyon' }),
        }));
        assertDeepEq(types(events), []);
    });

    test('the first snapshot never emits exit-node events', () => {
        const { events } = computeEvents(EMPTY_TRACK, snapshot({
            exitNodeID: 'n1', currentExitNode: node({ online: false }),
        }));
        assertDeepEq(types(events), []);
    });

    test('falls back to the dnsName leaf when hostname is empty', () => {
        const t = seed(pinned({ currentExitNode: node() }));
        const bare = node({ hostname: '', online: false });
        const { events } = computeEvents(t, pinned({ currentExitNode: bare }));
        assertEq(events[0].data.name, 'paris');
    });

    test('every event is flagged spontaneous', () => {
        const t = seed(pinned({ currentExitNode: node() }));
        const { events } = computeEvents(t, pinned({ currentExitNode: node({ online: false }) }));
        assertEq(events[0].spontaneous, true);
    });

    test('a pinned peer that vanishes from the netmap (currentExitNode: null) does not crash', () => {
        const t = seed(pinned({ currentExitNode: node() }));
        const { events } = computeEvents(t, pinned({ currentExitNode: null }));
        assertDeepEq(types(events), []);
    });
});

suite('SnapshotWatcher', () => {
    test('feed threads the tracker between calls', () => {
        const w = new SnapshotWatcher();
        assertDeepEq(types(w.feed(snapshot({ backendState: 'Starting' }))), ['connection-starting']);
        assertDeepEq(types(w.feed(snapshot({ backendState: 'Running' }))), ['connection-established']);
    });

    test('reset drops the accumulated state', () => {
        const w = new SnapshotWatcher();
        w.feed(snapshot({ backendState: 'Starting' }));
        w.reset();
        assertDeepEq(types(w.feed(snapshot({ backendState: 'Running' }))), []);
    });

    test('a null snapshot is ignored', () => {
        const w = new SnapshotWatcher();
        assertDeepEq(types(w.feed(null)), []);
    });
});

suite('computeEvents — account', () => {
    test('the first named account is silent', () => {
        const { events } = computeEvents(EMPTY_TRACK, snapshot({ accountName: 'alice@example.com' }));
        assertDeepEq(types(events), []);
    });

    test('an unchanged account emits nothing', () => {
        const t = seed(snapshot({ accountName: 'alice@example.com' }));
        const { events } = computeEvents(t, snapshot({ accountName: 'alice@example.com' }));
        assertDeepEq(types(events), []);
    });

    test('a genuine switch emits one non-spontaneous event', () => {
        const t = seed(snapshot({ accountName: 'alice@example.com' }));
        const { events } = computeEvents(t, snapshot({ accountName: 'bob@example.com' }));
        assertDeepEq(types(events), ['account-switched']);
        assertEq(events[0].category, 'profile-switch');
        assertEq(events[0].level, 'success');
        assertEq(events[0].spontaneous, false);
        assertEq(events[0].data.name, 'bob@example.com');
    });

    // A logged-out snapshot names no tailnet. Treating that as a switch would
    // fire on every logout, and forgetting the name would fire again on the
    // way back in.
    test('an empty account name is not a switch and is not remembered', () => {
        const t1 = seed(snapshot({ accountName: 'alice@example.com' }));
        const { events: out, track: t2 } = computeEvents(t1, snapshot({ accountName: null }));
        assertDeepEq(types(out), [], 'logging out is not a switch');
        const { events: back } = computeEvents(t2, snapshot({ accountName: 'alice@example.com' }));
        assertDeepEq(types(back), [], 'coming back to the same account is not a switch');
    });

    // A logged-out or failed-status first snapshot still sets `seeded: true`
    // with no accountName. The next snapshot that names a tailnet — e.g. the
    // user's first login of the session — must not read as a switch away
    // from "no account".
    test('a nameless first snapshot then the first login is silent', () => {
        const t = computeEvents(EMPTY_TRACK, snapshot({ accountName: null })).track;
        const { events } = computeEvents(t, snapshot({ accountName: 'alice@example.com' }));
        assertDeepEq(types(events), []);
    });

    // extension.js opens the quiet window while handling this event, so
    // everything the switch churns up must come after it in the batch.
    test('the account event leads its batch', () => {
        const withNode = (over = {}) => snapshot({
            autoExitNode: true,
            currentExitNode: node(),
            accountName: 'alice@example.com',
            ...over,
        });
        const t = seed(withNode());
        const { events } = computeEvents(t, withNode({
            accountName: 'bob@example.com',
            currentExitNode: node({ online: false }),
        }));
        assertDeepEq(types(events), ['account-switched', 'exit-node-lost']);
    });
});

suite('computeEvents — tailnet capabilities', () => {
    const caps = (over = {}) => snapshot({
        taildropAvailable: true,
        funnelsAvailable: true,
        ...over,
    });

    test('a grant and a revocation each report once', () => {
        const t = seed(caps({ taildropAvailable: false }));
        const { events, track } = computeEvents(t, caps({ funnelsAvailable: false }));
        assertDeepEq(types(events), ['taildrop-enabled', 'funnel-disabled']);
        assertEq(events[0].category, 'taildrop');
        assertEq(events[0].level, 'info');
        assertEq(events[1].category, 'funnel');
        assertEq(events[1].level, 'warning');
        // Reported once, not on every poll that follows.
        assertDeepEq(
            types(computeEvents(track, caps({ funnelsAvailable: false })).events),
            [],
        );
    });

    // The first snapshot is the state of the world, not a change to it: a
    // tailnet that has always forbidden Funnel must not announce it at login.
    test('the cold start reports nothing', () => {
        const { events } = computeEvents(
            EMPTY_TRACK, caps({ funnelsAvailable: false }));
        assertDeepEq(types(events), []);
    });

    // A daemon too old to publish a capability map, or a status that could
    // not be read, answers null — which is not a revocation, and must not
    // fire one on the way out or a re-grant on the way back.
    test('an unanswered poll is not a flip in either direction', () => {
        const t = seed(caps());
        const { events, track } = computeEvents(t, caps({ funnelsAvailable: null }));
        assertDeepEq(types(events), []);
        assertEq(track.funnelsAvailable, true);
        assertDeepEq(types(computeEvents(track, caps()).events), []);
    });

    test('a revocation seen through an unanswered poll still reports', () => {
        const t = seed(caps());
        const blind = computeEvents(t, caps({ funnelsAvailable: null })).track;
        const { events } = computeEvents(blind, caps({ funnelsAvailable: false }));
        assertDeepEq(types(events), ['funnel-disabled']);
    });
});

suite('computeEvents — the CLI itself', () => {
    const here = (over = {}) => snapshot({
        installed: true,
        accountName: 'tailnet-a',
        taildropAvailable: true,
        funnelsAvailable: true,
        exitNodeID: 'n1',
        currentExitNode: node(),
        ...over,
    });

    // What the client hands over once the binary is gone: an empty
    // snapshot, not an observation of one.
    const gone = () => snapshot({
        installed: false,
        backendState: 'NoState',
        accountName: null,
        taildropAvailable: null,
        funnelsAvailable: null,
        exitNodeID: null,
        currentExitNode: null,
    });

    test('losing the binary reports once, and only that', () => {
        const t = seed(here());
        const { events, track } = computeEvents(t, gone());
        assertDeepEq(types(events), ['tailscale-missing']);
        assertEq(events[0].level, 'error');
        assertEq(events[0].category, 'connection');
        // Every poll that follows lands here too and must stay quiet.
        assertDeepEq(types(computeEvents(track, gone()).events), []);
    });

    // The account, the exit node and both capabilities all read as "gone"
    // off that snapshot. None of them went anywhere; the binary did.
    test('an empty snapshot does not report the world emptying with it', () => {
        const t = seed(here());
        const { events } = computeEvents(t, gone());
        assertEq(events.length, 1);
    });

    test('the tracker keeps the world it had, so the return trip is quiet', () => {
        const t = seed(here());
        const away = computeEvents(t, gone()).track;
        assertEq(away.accountName, 'tailnet-a');
        assertEq(away.taildropAvailable, true);
        const { events } = computeEvents(away, here());
        assertDeepEq(types(events), ['tailscale-installed']);
        assertEq(events[0].level, 'info');
    });

    // A machine that has never had Tailscale would otherwise be told so at
    // every login, about a state the panel already shows.
    test('the cold start reports nothing', () => {
        assertDeepEq(types(computeEvents(EMPTY_TRACK, gone()).events), []);
    });

    // Snapshots built before this field existed, and the ones the other
    // suites here still use, must not read as an uninstall.
    test('an absent field is not a flip', () => {
        const t = seed(snapshot({ accountName: 'tailnet-a' }));
        assertDeepEq(types(computeEvents(t, snapshot()).events), []);
    });
});
