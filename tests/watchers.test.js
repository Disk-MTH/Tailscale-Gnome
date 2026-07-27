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
