# Notification System Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single OSD-toast notification path with two user-selectable modes — a persistent native notification history and the existing toast — gated by nine per-category switches, and collapse the account-switch notification burst into a single entry.

**Architecture:** A policy layer (`notify.js` + the pure `notify-policy.js`) sits between the ~36 call sites and two interchangeable render backends (`tray.js` for native `MessageTray` notifications, `toast.js` for the existing OSD actor). Snapshot-diffing logic moves out of `menu.js` into a pure `watchers.js`. Every module that carries decision logic is free of `resource:///org/gnome/shell/…` imports so it can be unit-tested by `gjs` outside a Shell session.

**Tech Stack:** GJS / ES modules, GNOME Shell 49–50 extension APIs (`MessageTray`, `St`, `Clutter`), GSettings/GSchema, libadwaita (`Adw`) for preferences, plain `gjs -m` for tests, `shexli` for EGO static analysis.

**Spec:** `docs/superpowers/specs/2026-07-26-notifications-design.md`

## Global Constraints

- Target GNOME Shell versions: `["49", "50"]` (`metadata.json`). Do not use APIs added after 50 or removed before 49.
- All shipped code, comments, and translatable strings are **English**. The spec and this plan are French; nothing in them is copy-paste material for source files.
- No new runtime dependencies. No `package.json`, no `node_modules`. Tests run on the system `gjs` only.
- Every `GLib.timeout_add*` / `GLib.idle_add*` source id must be stored, removed in `destroy()`, and **zeroed before any re-arm** (`clear-before-rearm` — the defect class behind the v0.2.1 EGO rejection).
- Verification baseline at `ff1d842`: `make pack && shexli tailscale-gnome@diskmth.fr.shell-extension.zip` reports **0 errors, 0 warnings**, 1 `manual_review` (clipboard, declared in `metadata.json`). No task may regress this.
- Branch: `feat/notification-rewrite`. Commit after every task.
- `tests/` must never ship: the `pack` target enumerates files explicitly — do not add `tests` to it.
- Notification levels are exactly `'pending' | 'info' | 'success' | 'warning' | 'error'` throughout.
- Category identifiers are exactly `'connection' | 'account' | 'profile-switch' | 'exit-node' | 'network' | 'taildrop' | 'funnel' | 'errors' | 'misc'`.

## Verified GNOME Shell 50 API facts

Relied on by Tasks 5 and 7; taken from `js/ui/messageTray.js` on branch `gnome-50`.

- `MessageTray.Source` ctor props: `title` (string), `icon` (`Gio.Icon`), `policy`. Registered with `Main.messageTray.add(source)`.
- `MessageTray.Notification` ctor props (GJS camelCase): `source`, `title`, `body`, `gicon`, `iconName`, `urgency`, `acknowledged`, `isTransient`, `resident`, `datetime`, `privacyScope`, `useBodyMarkup`.
- `source.notifications` is a plain `Array`, oldest first.
- `MAX_NOTIFICATIONS_PER_SOURCE = 10` — hard ceiling on history size.
- `Source._onNotificationDestroy` self-destructs the source at zero notifications:
  `if (!this._inDestruction && this.notifications.length === 0) this.destroy();`
- `notification.destroy(reason)` defaults to `DISMISSED`; eviction must pass `MessageTray.NotificationDestroyedReason.EXPIRED`.
- `_onNotificationRequestBanner` returns early when `notification.acknowledged` is true — writing `acknowledged = false` is what re-triggers a banner.
- `NOTIFICATION_TIMEOUT = 4000` is a module constant; only `Urgency.CRITICAL` escapes it. Banner duration is therefore **not** configurable and must not be patched.
- `MessageTray.Urgency = { LOW: 0, NORMAL: 1, HIGH: 2, CRITICAL: 3 }`; the banner queue sorts by descending urgency.

---

### Task 1: Test harness and the pure notification policy

**Files:**
- Create: `tests/harness.js`
- Create: `tests/run.js`
- Create: `tests/notify-policy.test.js`
- Create: `lib/notify-policy.js`
- Modify: `Makefile` (add `test` target and `.PHONY` entry)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Category` — frozen object, values listed in Global Constraints.
  - `CATEGORY_KEY` — frozen map `category → GSettings key name`.
  - `QuietScope` — frozen `{ SPONTANEOUS: 'spontaneous', ALL: 'all' }`.
  - `class NotifyPolicy` with `setCategoryEnabled(category, enabled)`, `isCategoryEnabled(category) → boolean`, `beginQuiet(scope) → number`, `endQuiet(token)`, `clearQuiet()`, `get quietCount() → number`, `shouldShow({category, level, spontaneous, force}) → boolean`.
  - Test helpers `suite`, `test`, `assertTrue`, `assertFalse`, `assertEq`, `assertDeepEq`, `report`.

- [ ] **Step 1: Create the test harness**

`tests/harness.js`:

```js
// Zero-dependency test harness. Runs under plain `gjs -m` so the pure
// modules can be exercised without a live GNOME Shell session — anything
// importing `resource:///org/gnome/shell/…` cannot be tested here.

let _failures = 0;
let _total = 0;
const _path = [];

export function suite(name, fn) {
    _path.push(name);
    try {
        fn();
    } finally {
        _path.pop();
    }
}

export function test(name, fn) {
    _total++;
    const label = [..._path, name].join(' > ');
    try {
        fn();
    } catch (e) {
        _failures++;
        printerr(`FAIL  ${label}`);
        printerr(`      ${e.message}`);
    }
}

export function assertTrue(value, msg = '') {
    if (value !== true)
        throw new Error(`${msg || 'expected true'} — got ${JSON.stringify(value)}`);
}

export function assertFalse(value, msg = '') {
    if (value !== false)
        throw new Error(`${msg || 'expected false'} — got ${JSON.stringify(value)}`);
}

export function assertEq(actual, expected, msg = '') {
    if (actual !== expected) {
        throw new Error(
            `${msg || 'not equal'} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

export function assertDeepEq(actual, expected, msg = '') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b)
        throw new Error(`${msg || 'not deep-equal'} — expected ${b}, got ${a}`);
}

export function report() {
    if (_failures === 0) {
        print(`ok — ${_total} tests passed`);
        return 0;
    }
    printerr(`FAILED — ${_failures} of ${_total} tests failed`);
    return 1;
}
```

`tests/run.js`:

```js
// Entry point: `make test`, or `gjs -m tests/run.js`.
import System from 'system';

import { report } from './harness.js';

import './notify-policy.test.js';

System.exit(report());
```

- [ ] **Step 2: Write the failing test**

`tests/notify-policy.test.js`:

```js
import { suite, test, assertTrue, assertFalse, assertEq } from './harness.js';
import { Category, CATEGORY_KEY, QuietScope, NotifyPolicy } from '../lib/notify-policy.js';

const show = (policy, opts) => policy.shouldShow({
    category: Category.TAILDROP, level: 'info', ...opts,
});

suite('NotifyPolicy', () => {
    test('every category maps to a GSettings key', () => {
        for (const category of Object.values(Category))
            assertEq(typeof CATEGORY_KEY[category], 'string', `key for ${category}`);
    });

    test('categories default to enabled', () => {
        const p = new NotifyPolicy();
        assertTrue(show(p, {}), 'unconfigured category passes');
    });

    test('a disabled category is filtered', () => {
        const p = new NotifyPolicy();
        p.setCategoryEnabled(Category.TAILDROP, false);
        assertFalse(show(p, {}), 'info in a muted category is dropped');
    });

    test('errors pass through a muted category', () => {
        const p = new NotifyPolicy();
        p.setCategoryEnabled(Category.TAILDROP, false);
        assertTrue(show(p, { level: 'error' }), 'error escapes via notify-errors');
        assertTrue(show(p, { level: 'warning' }), 'warning escapes via notify-errors');
    });

    test('muting errors closes the safety net', () => {
        const p = new NotifyPolicy();
        p.setCategoryEnabled(Category.TAILDROP, false);
        p.setCategoryEnabled(Category.ERRORS, false);
        assertFalse(show(p, { level: 'error' }), 'no escape once errors are muted');
    });

    test('an enabled category shows errors regardless of notify-errors', () => {
        const p = new NotifyPolicy();
        p.setCategoryEnabled(Category.ERRORS, false);
        assertTrue(show(p, { level: 'error' }), 'own category still wins');
    });

    test('a spontaneous window mutes only spontaneous notifications', () => {
        const p = new NotifyPolicy();
        p.beginQuiet(QuietScope.SPONTANEOUS);
        assertFalse(show(p, { spontaneous: true }), 'spontaneous is muted');
        assertTrue(show(p, { spontaneous: false }), 'user action still passes');
    });

    test('an all window mutes everything', () => {
        const p = new NotifyPolicy();
        p.beginQuiet(QuietScope.ALL);
        assertFalse(show(p, { spontaneous: false }), 'user action is muted too');
        assertFalse(show(p, { spontaneous: true }), 'spontaneous is muted');
    });

    test('force bypasses quiet but never the category filter', () => {
        const p = new NotifyPolicy();
        p.beginQuiet(QuietScope.ALL);
        assertTrue(show(p, { force: true }), 'force escapes the quiet window');
        p.setCategoryEnabled(Category.TAILDROP, false);
        assertFalse(show(p, { force: true }), 'force does not override a muted category');
    });

    test('quiet windows nest and release by token', () => {
        const p = new NotifyPolicy();
        const a = p.beginQuiet(QuietScope.ALL);
        const b = p.beginQuiet(QuietScope.ALL);
        assertEq(p.quietCount, 2, 'two windows open');
        p.endQuiet(a);
        assertFalse(show(p, {}), 'still muted while the second window is open');
        p.endQuiet(b);
        assertTrue(show(p, {}), 'released once the last window closes');
        assertEq(p.quietCount, 0, 'stack drained');
    });

    test('endQuiet on an unknown token is harmless', () => {
        const p = new NotifyPolicy();
        p.endQuiet(9999);
        assertEq(p.quietCount, 0, 'no spurious entry');
    });

    test('clearQuiet drains the stack', () => {
        const p = new NotifyPolicy();
        p.beginQuiet(QuietScope.ALL);
        p.beginQuiet(QuietScope.SPONTANEOUS);
        p.clearQuiet();
        assertEq(p.quietCount, 0, 'drained');
        assertTrue(show(p, { spontaneous: true }), 'nothing muted after a clear');
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `gjs -m tests/run.js`
Expected: FAIL — `ImportError: Unable to load file from: .../lib/notify-policy.js`

- [ ] **Step 4: Write the implementation**

`lib/notify-policy.js`:

```js
// Pure notification policy: decides whether a notification is allowed
// through, and tracks the quiet windows that suppress bursts.
//
// Deliberately free of any `resource:///org/gnome/shell/…` import so
// `make test` can exercise the rules outside a Shell session. Everything
// needing Shell APIs lives in notify.js and the two render backends.

/** Notification domains. One GSettings switch each — see CATEGORY_KEY. */
export const Category = Object.freeze({
    CONNECTION:     'connection',
    ACCOUNT:        'account',
    PROFILE_SWITCH: 'profile-switch',
    EXIT_NODE:      'exit-node',
    NETWORK:        'network',
    TAILDROP:       'taildrop',
    FUNNEL:         'funnel',
    ERRORS:         'errors',
    MISC:           'misc',
});

export const CATEGORY_KEY = Object.freeze({
    [Category.CONNECTION]:     'notify-connection',
    [Category.ACCOUNT]:        'notify-account',
    [Category.PROFILE_SWITCH]: 'notify-profile-switch',
    [Category.EXIT_NODE]:      'notify-exit-node',
    [Category.NETWORK]:        'notify-network',
    [Category.TAILDROP]:       'notify-taildrop',
    [Category.FUNNEL]:         'notify-funnel',
    [Category.ERRORS]:         'notify-errors',
    [Category.MISC]:           'notify-misc',
});

/**
 * How far a quiet window reaches.
 *
 * SPONTANEOUS silences only what nobody asked for — watcher events and
 * daemon signals — so two user actions in quick succession still both
 * report. This is the pre-existing `hasActiveOp` behaviour.
 *
 * ALL silences everything except `force`, and is used while an account
 * switch churns the whole snapshot.
 */
export const QuietScope = Object.freeze({
    SPONTANEOUS: 'spontaneous',
    ALL:         'all',
});

// Levels that the `errors` switch lets escape a muted category, so muting
// a domain never turns its failures silent.
const ALERT_LEVELS = Object.freeze(['warning', 'error']);

export class NotifyPolicy {
    constructor() {
        this._enabled = new Map();
        this._quiet = new Map();   // token -> QuietScope
        this._nextToken = 1;
    }

    /** @param {string} category @param {boolean} enabled */
    setCategoryEnabled(category, enabled) {
        this._enabled.set(category, !!enabled);
    }

    /** Unconfigured categories default to on, matching the schema defaults. */
    isCategoryEnabled(category) {
        return this._enabled.get(category) ?? true;
    }

    /**
     * Open a quiet window.
     *
     * @param {string} scope one of QuietScope
     * @returns {number} token to pass back to endQuiet()
     */
    beginQuiet(scope) {
        const token = this._nextToken++;
        this._quiet.set(token, scope);
        return token;
    }

    /** Idempotent: closing an unknown or already-closed token is a no-op. */
    endQuiet(token) {
        this._quiet.delete(token);
    }

    clearQuiet() {
        this._quiet.clear();
    }

    get quietCount() {
        return this._quiet.size;
    }

    _hasScope(scope) {
        for (const s of this._quiet.values()) {
            if (s === scope)
                return true;
        }
        return false;
    }

    /**
     * @param {{category: string, level: string, spontaneous?: boolean,
     *          force?: boolean}} opts
     * @returns {boolean}
     */
    shouldShow({ category, level, spontaneous = false, force = false }) {
        if (!force) {
            if (this._hasScope(QuietScope.ALL))
                return false;
            if (spontaneous && this._hasScope(QuietScope.SPONTANEOUS))
                return false;
        }
        if (this.isCategoryEnabled(category))
            return true;
        // Safety net: a muted domain must not hide its own failures.
        return ALERT_LEVELS.includes(level) &&
            this.isCategoryEnabled(Category.ERRORS);
    }
}
```

- [ ] **Step 5: Add the Makefile target**

In `Makefile`, add `test` to the `.PHONY` line so it reads:

```make
.PHONY: all schemas install uninstall enable disable reset pack clean test test-syntax help
```

Add a help line after the `test-syntax` one:

```make
	@printf "  test         Run the unit tests for the pure modules via gjs\n"
```

Add the target after `test-syntax`:

```make
# Unit tests for the modules that carry no Shell imports (notify-policy,
# watchers). Anything importing resource:///org/gnome/shell/… cannot run
# outside a live session and is covered by the manual checklist instead.
test:
	@gjs -m tests/run.js
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `make test`
Expected: `ok — 12 tests passed`, exit status 0

- [ ] **Step 7: Commit**

```bash
git add tests/harness.js tests/run.js tests/notify-policy.test.js lib/notify-policy.js Makefile
git commit -m "test: add gjs test harness and the pure notification policy

Category/level filtering with the errors switch as a safety net, plus the
two-scope quiet stack that replaces hasActiveOp and isLoadingSlot. Kept
free of Shell imports so it runs under plain gjs."
```

---

### Task 2: Pure snapshot watchers

**Files:**
- Create: `lib/watchers.js`
- Create: `tests/watchers.test.js`
- Modify: `tests/run.js` (register the new test module)

**Interfaces:**
- Consumes: `Category` from `lib/notify-policy.js`.
- Produces:
  - `EMPTY_TRACK` — frozen initial tracker.
  - `computeEvents(track, snap) → { events, track }` where each event is `{ type, category, level, spontaneous: true, data }`.
  - `class SnapshotWatcher` with `feed(snap) → events[]` and `reset()`.
  - Event `type` values: `connection-starting`, `connection-established`, `connection-ended`, `exit-node-lost`, `exit-node-acquired`, `exit-node-switched`, `exit-node-offline`, `exit-node-online`, `exit-node-disabled`, `exit-node-reenabled`.

Events carry **no user-facing strings** — only `data`. Callers map `type` to translated copy, which is what keeps this module free of the gettext import and therefore testable.

- [ ] **Step 1: Register the test module**

In `tests/run.js`, add below the existing import:

```js
import './watchers.test.js';
```

- [ ] **Step 2: Write the failing test**

`tests/watchers.test.js`:

```js
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `make test`
Expected: FAIL — `ImportError: Unable to load file from: .../lib/watchers.js`

- [ ] **Step 4: Write the implementation**

`lib/watchers.js`:

```js
// Snapshot diffing: turns successive TailscaleClient snapshots into
// semantic events (exit node lost, connection established, …).
//
// Two properties are load-bearing. First, no `resource:///org/gnome/shell/…`
// import, so `make test` exercises the rules directly. Second, events carry
// data but never user-facing text — callers map `type` to translated copy —
// which is what keeps the gettext import out of this file.
//
// Lifted out of menu.js, where _maybeToastConnection and
// _maybeToastExitNodeChange had no business living: they render nothing.

import { Category } from './notify-policy.js';

/** Cold-start tracker. Threaded through computeEvents(). */
export const EMPTY_TRACK = Object.freeze({
    backendState:    null,
    pendingConnection: false,
    seeded:          false,
    autoExitNode:    null,
    effectiveNodeId: null,
    exitNodeID:      null,
    nodeOnline:      null,
    nodeOption:      null,
});

// A node only counts as "effective" when actually routable: online AND
// still advertising as an exit. The daemon does not clear `ExitNode: true`
// when its picked node goes offline, so a raw ID compare would miss that
// transition — the pill would show "Auto (None)" with no event fired.
function _effectiveId(node) {
    return node && node.online && node.exitNodeOption ? node.id : null;
}

function _nameOf(node) {
    if (!node)
        return null;
    return node.hostname || node.dnsName?.split('.')[0] || null;
}

function _event(type, level, data = {}) {
    return {
        type,
        category: type.startsWith('connection-')
            ? Category.CONNECTION
            : Category.EXIT_NODE,
        level,
        spontaneous: true,
        data,
    };
}

function _connectionEvents(track, snap, out) {
    const prev = track.backendState;
    const now = snap.backendState;
    if (prev === now)
        return track.pendingConnection;

    if (now === 'Starting') {
        out.push(_event('connection-starting', 'pending'));
        return true;
    }
    // Only resolve a phase we actually announced; a daemon that reaches
    // Running without passing through Starting was never pending.
    if (!track.pendingConnection)
        return false;

    if (now === 'Running')
        out.push(_event('connection-established', 'success'));
    else
        out.push(_event('connection-ended', 'info', { backendState: now }));
    return false;
}

function _exitNodeEvents(track, snap, out) {
    if (!track.seeded)
        return;

    const curr = snap.currentExitNode;
    const currEff = _effectiveId(curr);
    const name = _nameOf(curr);

    if (track.autoExitNode && snap.autoExitNode) {
        const prevEff = track.effectiveNodeId;
        if (prevEff && !currEff)
            out.push(_event('exit-node-lost', 'warning'));
        else if (!prevEff && currEff)
            out.push(_event('exit-node-acquired', 'info', { name }));
        else if (prevEff && currEff && prevEff !== currEff)
            out.push(_event('exit-node-switched', 'info', { name }));
        return;
    }

    // Pinned mode: only report on the node the user chose, and only while
    // that choice is unchanged. A different exitNodeID means the user just
    // picked something else, which already produced its own feedback.
    if (track.autoExitNode || snap.autoExitNode)
        return;
    if (!track.exitNodeID || track.exitNodeID !== snap.exitNodeID)
        return;
    if (!curr)
        return;

    if (track.nodeOnline !== null) {
        if (track.nodeOnline && !curr.online)
            out.push(_event('exit-node-offline', 'warning', { name }));
        else if (!track.nodeOnline && curr.online)
            out.push(_event('exit-node-online', 'info', { name }));
    }
    if (track.nodeOption !== null) {
        if (track.nodeOption && !curr.exitNodeOption)
            out.push(_event('exit-node-disabled', 'warning', { name }));
        else if (!track.nodeOption && curr.exitNodeOption)
            out.push(_event('exit-node-reenabled', 'info', { name }));
    }
}

/**
 * @param {object} track previous tracker; EMPTY_TRACK on cold start
 * @param {object} snap  fresh TailscaleClient snapshot
 * @returns {{events: Array<object>, track: object}}
 */
export function computeEvents(track, snap) {
    if (!snap)
        return { events: [], track };

    const events = [];
    const pendingConnection = _connectionEvents(track, snap, events);
    _exitNodeEvents(track, snap, events);

    const curr = snap.currentExitNode;
    return {
        events,
        track: {
            backendState:      snap.backendState,
            pendingConnection,
            seeded:            true,
            autoExitNode:      snap.autoExitNode,
            effectiveNodeId:   _effectiveId(curr),
            exitNodeID:        snap.exitNodeID,
            nodeOnline:        curr?.online ?? null,
            nodeOption:        curr?.exitNodeOption ?? null,
        },
    };
}

/** Thin stateful wrapper around computeEvents(). */
export class SnapshotWatcher {
    constructor() {
        this._track = EMPTY_TRACK;
    }

    /**
     * @param {object} snap
     * @returns {Array<object>} events produced by this snapshot
     */
    feed(snap) {
        const { events, track } = computeEvents(this._track, snap);
        this._track = track;
        return events;
    }

    reset() {
        this._track = EMPTY_TRACK;
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `make test`
Expected: `ok — 30 tests passed`, exit status 0

- [ ] **Step 6: Commit**

```bash
git add lib/watchers.js tests/watchers.test.js tests/run.js
git commit -m "feat: extract snapshot diffing into a pure watchers module

Ports _maybeToastConnection and _maybeToastExitNodeChange out of menu.js as
a pure function of (tracker, snapshot). Events carry data, never translated
strings, which keeps the module free of Shell imports and unit-testable."
```

---

### Task 3: GSettings schema

**Files:**
- Modify: `schemas/org.gnome.shell.extensions.tailscale-gnome.gschema.xml`

**Interfaces:**
- Consumes: the key names from `CATEGORY_KEY` (Task 1).
- Produces: keys `notification-mode`, `notification-history-size`, and the nine `notify-*` booleans, all readable via `Gio.Settings`.

- [ ] **Step 1: Add the enum and the new keys**

In `schemas/org.gnome.shell.extensions.tailscale-gnome.gschema.xml`, insert the enum immediately after the opening `<schemalist …>` line and **before** `<schema id=…>`:

```xml
    <enum id="org.gnome.shell.extensions.tailscale-gnome.notification-mode">
        <value nick="persistent" value="0"/>
        <value nick="toast" value="1"/>
    </enum>
```

Then replace the existing `toast-duration` / `toast-min-spinner` block (currently the last keys before `</schema>`) with:

```xml
        <key name="notification-mode"
             enum="org.gnome.shell.extensions.tailscale-gnome.notification-mode">
            <default>'persistent'</default>
            <summary>How notifications are presented</summary>
            <description>"persistent" posts native GNOME notifications that
                stack into a browsable history under a single Tailscale
                entry. "toast" shows the transient on-screen bubble and
                keeps no history.</description>
        </key>

        <key name="notification-history-size" type="u">
            <default>5</default>
            <range min="1" max="10"/>
            <summary>Entries kept in the notification history</summary>
            <description>Persistent mode only. Once the history is full the
                oldest entry is evicted. GNOME Shell caps a notification
                source at 10, which is the hard ceiling here.</description>
        </key>

        <key name="toast-duration" type="u">
            <default>3</default>
            <range min="1" max="10"/>
            <summary>Toast display duration (seconds)</summary>
            <description>Toast mode only. How long success / error / info
                toasts stay on screen after the action completes. Persistent
                mode uses GNOME's own banner timeout, which is not
                configurable.</description>
        </key>

        <key name="toast-min-spinner" type="u">
            <default>1000</default>
            <range min="0" max="3000"/>
            <summary>Minimum pending duration (milliseconds)</summary>
            <description>Floor the pending state stays visible before
                transitioning to the result, so instant operations don't
                flash. Applies to both modes. 0 disables the floor.</description>
        </key>

        <key name="notify-connection" type="b">
            <default>true</default>
            <summary>Notify about connecting and disconnecting</summary>
        </key>
        <key name="notify-account" type="b">
            <default>true</default>
            <summary>Notify about login, logout and operator changes</summary>
        </key>
        <key name="notify-profile-switch" type="b">
            <default>true</default>
            <summary>Notify when a different profile is applied</summary>
        </key>
        <key name="notify-exit-node" type="b">
            <default>true</default>
            <summary>Notify about exit-node selection and availability</summary>
        </key>
        <key name="notify-network" type="b">
            <default>true</default>
            <summary>Notify about Magic DNS, routes, shields, SSH and LAN access</summary>
        </key>
        <key name="notify-taildrop" type="b">
            <default>true</default>
            <summary>Notify about Taildrop transfers and the receiver</summary>
        </key>
        <key name="notify-funnel" type="b">
            <default>true</default>
            <summary>Notify about Funnel ports</summary>
        </key>
        <key name="notify-errors" type="b">
            <default>true</default>
            <summary>Let failures through even when their category is off</summary>
            <description>Acts as a safety net rather than a category of its
                own: muting Taildrop hides its successes but not its
                failures. Turning this off as well produces total
                silence.</description>
        </key>
        <key name="notify-misc" type="b">
            <default>true</default>
            <summary>Notify about clipboard copies and manual refreshes</summary>
        </key>
```

- [ ] **Step 2: Compile the schema to verify it is valid**

Run: `make schemas`
Expected: no output, exit status 0. A malformed enum or a default outside its range fails here with a `glib-compile-schemas` error.

- [ ] **Step 3: Verify the defaults read back**

Run:
```bash
gsettings --schemadir schemas list-recursively org.gnome.shell.extensions.tailscale-gnome | grep -E "notif" | sort
```
Expected exactly:
```
org.gnome.shell.extensions.tailscale-gnome notification-history-size uint32 5
org.gnome.shell.extensions.tailscale-gnome notification-mode 'persistent'
org.gnome.shell.extensions.tailscale-gnome notify-account true
org.gnome.shell.extensions.tailscale-gnome notify-connection true
org.gnome.shell.extensions.tailscale-gnome notify-errors true
org.gnome.shell.extensions.tailscale-gnome notify-exit-node true
org.gnome.shell.extensions.tailscale-gnome notify-funnel true
org.gnome.shell.extensions.tailscale-gnome notify-misc true
org.gnome.shell.extensions.tailscale-gnome notify-network true
org.gnome.shell.extensions.tailscale-gnome notify-profile-switch true
org.gnome.shell.extensions.tailscale-gnome notify-taildrop true
```

- [ ] **Step 4: Commit**

```bash
git add schemas/org.gnome.shell.extensions.tailscale-gnome.gschema.xml
git commit -m "feat(schema): add notification mode, history size and category switches

notification-mode defaults to persistent. toast-duration keeps its meaning
but is now documented as toast-only; toast-min-spinner applies to both modes
and its summary is reworded accordingly."
```

---

### Task 4: Preferences page

**Files:**
- Modify: `prefs.js` (add `_makeNotificationsPage`, call it from `fillPreferencesWindow`, remove the two toast rows from the Advanced group)

**Interfaces:**
- Consumes: the schema keys from Task 3.
- Produces: no exported symbol; a second `Adw.PreferencesPage` in the preferences window.

- [ ] **Step 1: Add the page builder**

In `prefs.js`, insert this function immediately before the `/* Page */` banner comment near the end of the file (currently around line 720):

```js
/* -------------------------------------------------------------------------- */
/*                             Notifications page                             */
/* -------------------------------------------------------------------------- */

// Every event the extension can report, in the order they appear in the
// page. Keys match CATEGORY_KEY in lib/notify-policy.js.
const NOTIFY_DEFS = [
    {
        key: 'notify-connection',
        title: _('Tailscale connection'),
        subtitle: _('Connecting, disconnecting, and daemon startup.'),
    },
    {
        key: 'notify-account',
        title: _('Login and logout'),
        subtitle: _('Sign-in, sign-out, and operator changes.'),
    },
    {
        key: 'notify-profile-switch',
        title: _('Profile switch'),
        subtitle: _('A single notification once the new profile is applied.'),
    },
    {
        key: 'notify-exit-node',
        title: _('Exit node'),
        subtitle: _('Selection, going offline, and automatic switches.'),
    },
    {
        key: 'notify-network',
        title: _('Network settings'),
        subtitle: _('Magic DNS, routes, shields up, SSH server, LAN access.'),
    },
    {
        key: 'notify-taildrop',
        title: _('Taildrop'),
        subtitle: _('Files sent and received, receiver started and stopped.'),
    },
    {
        key: 'notify-funnel',
        title: _('Funnel'),
        subtitle: _('Ports added and removed.'),
    },
    {
        key: 'notify-misc',
        title: _('Other'),
        subtitle: _('Clipboard copies and manual refreshes.'),
    },
];

function _makeNotificationsPage(settings) {
    const page = new Adw.PreferencesPage({
        title: _('Notifications'),
        iconName: 'preferences-system-notifications-symbolic',
    });

    /* ------------------------------- Mode -------------------------------- */
    const modeGroup = new Adw.PreferencesGroup({
        title: _('Mode'),
        description: _(
            'Persistent mode posts native notifications that stack into a browsable history. Toast mode shows a transient bubble and keeps no history.',
        ),
    });
    page.add(modeGroup);

    const modeRow = new Adw.ComboRow({
        title: _('Presentation'),
        model: Gtk.StringList.new([_('Persistent'), _('Toast')]),
    });
    // The enum nicks in schema order; index maps 1:1 onto the StringList.
    const MODES = ['persistent', 'toast'];
    modeRow.selected = Math.max(0, MODES.indexOf(settings.get_string('notification-mode')));
    modeRow.connect('notify::selected', () => {
        settings.set_string('notification-mode', MODES[modeRow.selected]);
    });
    modeRow.add_suffix(_resetButton(settings, 'notification-mode'));
    modeGroup.add(modeRow);

    const historyRow = new Adw.SpinRow({
        title: _('History size'),
        subtitle: _('Entries kept before the oldest is dropped (1 to 10).'),
        adjustment: new Gtk.Adjustment({
            lower: 1,
            upper: 10,
            step_increment: 1,
            page_increment: 1,
        }),
    });
    settings.bind(
        'notification-history-size',
        historyRow,
        'value',
        Gio.SettingsBindFlags.DEFAULT,
    );
    historyRow.add_suffix(_resetButton(settings, 'notification-history-size'));
    modeGroup.add(historyRow);

    const durationRow = new Adw.SpinRow({
        title: _('Toast duration'),
        subtitle: _('Seconds the result toast stays on screen (1 to 10).'),
        adjustment: new Gtk.Adjustment({
            lower: 1,
            upper: 10,
            step_increment: 1,
            page_increment: 1,
        }),
    });
    settings.bind(
        'toast-duration',
        durationRow,
        'value',
        Gio.SettingsBindFlags.DEFAULT,
    );
    durationRow.add_suffix(_resetButton(settings, 'toast-duration'));
    modeGroup.add(durationRow);

    const spinnerRow = new Adw.SpinRow({
        title: _('Minimum pending duration'),
        subtitle: _(
            'Milliseconds the pending state stays visible before showing the result (0 to 3000). Prevents flicker on instant actions.',
        ),
        adjustment: new Gtk.Adjustment({
            lower: 0,
            upper: 3000,
            step_increment: 100,
            page_increment: 500,
        }),
    });
    settings.bind(
        'toast-min-spinner',
        spinnerRow,
        'value',
        Gio.SettingsBindFlags.DEFAULT,
    );
    spinnerRow.add_suffix(_resetButton(settings, 'toast-min-spinner'));
    modeGroup.add(spinnerRow);

    // Only the rows that apply to the active mode are shown. The minimum
    // pending duration applies to both, so it always stays visible.
    const syncModeRows = () => {
        const persistent = settings.get_string('notification-mode') === 'persistent';
        historyRow.visible = persistent;
        durationRow.visible = !persistent;
    };
    syncModeRows();
    settings.connect('changed::notification-mode', () => {
        modeRow.selected = Math.max(0, MODES.indexOf(settings.get_string('notification-mode')));
        syncModeRows();
    });

    /* ------------------------------ Events ------------------------------- */
    const eventsGroup = new Adw.PreferencesGroup({
        title: _('Events'),
        description: _('Which actions are allowed to notify.'),
    });
    page.add(eventsGroup);

    for (const def of NOTIFY_DEFS) {
        const row = new Adw.SwitchRow({
            title: def.title,
            subtitle: def.subtitle,
        });
        settings.bind(def.key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(_resetButton(settings, def.key));
        eventsGroup.add(row);
    }

    /* ------------------------------ Failures ----------------------------- */
    // Separate group so it reads as an override rather than a ninth
    // category: it lets failures through even when their own category is
    // off, and turning it off is what produces total silence.
    const errorsGroup = new Adw.PreferencesGroup({
        title: _('Failures'),
    });
    page.add(errorsGroup);

    const errorsRow = new Adw.SwitchRow({
        title: _('Always report failures'),
        subtitle: _(
            'Let errors and warnings through even when the category above is off. Turn this off as well for complete silence.',
        ),
    });
    settings.bind('notify-errors', errorsRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    errorsRow.add_suffix(_resetButton(settings, 'notify-errors'));
    errorsGroup.add(errorsRow);

    return page;
}
```

- [ ] **Step 2: Register the page and drop the old toast rows**

In `fillPreferencesWindow`, immediately after `window.add(page);` add:

```js
        window.add(_makeNotificationsPage(settings));
```

Then delete the two now-duplicated blocks from the Advanced group — the `toastDurRow` block (currently `prefs.js:809-826`) and the `spinnerRow` block (currently `prefs.js:828-847`), including their `advanced.add(...)` calls. The `binaryRow` block that follows stays.

- [ ] **Step 3: Verify the syntax**

Run: `make test-syntax`
Expected: every file prints `OK`

- [ ] **Step 4: Verify the page renders**

Run:
```bash
make install && gnome-extensions prefs tailscale-gnome@diskmth.fr
```
Expected: a second page named **Notifications** with a working mode selector; picking **Toast** hides *History size* and reveals *Toast duration*, picking **Persistent** does the reverse. The Advanced group on the General page no longer lists *Toast duration* or *Minimum spinner duration*.

- [ ] **Step 5: Commit**

```bash
git add prefs.js
git commit -m "feat(prefs): add the Notifications page

Mode selector with per-mode rows, eight category switches, and the failures
override in its own group so it reads as an override rather than a ninth
category. Moves the two toast rows off the crowded General page."
```

---

### Task 5: Persistent backend

**Files:**
- Create: `lib/tray.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `TrayBackend` with `configure({historySize, gicon})`, `show({message, level, gicon}) → handle`, `destroy()`; handle has `update({message, level})` and `dismiss()`.

Nothing imports this yet — Task 7 wires it. It is written first so the trickiest module lands on its own reviewable commit.

- [ ] **Step 1: Write the backend**

`lib/tray.js`:

```js
// Persistent notification backend: native GNOME notifications grouped under
// a single "Tailscale" source, forming a browsable history of the last N
// events.
//
// Three GNOME Shell behaviours drive the design (verified in gnome-50
// js/ui/messageTray.js):
//
//   - A Source *is* the requested queue. addNotification() already evicts
//     the oldest past MAX_NOTIFICATIONS_PER_SOURCE (10); we evict earlier so
//     the configured size wins instead of the hard ceiling.
//   - A Source destroys itself the moment it drops to zero notifications,
//     which happens whenever the user clears the list. The reference must be
//     dropped on 'destroy' and the source rebuilt lazily.
//   - Banner duration is a module constant (4s) that only CRITICAL escapes.
//     It is deliberately left alone: patching a Shell internal is not worth
//     the review risk. Writing acknowledged = false is what re-banners an
//     updated notification — GNOME then mutates the live banner if it is
//     still showing, or queues a fresh one if it is not.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

// Fallback symbolics when no gicon applies. 'pending' has no entry: it
// reuses the generic icon, since a native notification has no spinner.
const LEVEL_ICONS = {
    pending: 'content-loading-symbolic',
    info:    'dialog-information-symbolic',
    success: 'object-select-symbolic',
    warning: 'dialog-warning-symbolic',
    error:   'dialog-error-symbolic',
};

// Warnings and errors sort ahead of the rest in the banner queue, which
// MessageTray orders by descending urgency. CRITICAL is never used: it makes
// the banner sticky until dismissed, which is disproportionate here.
function _urgencyFor(level) {
    return level === 'warning' || level === 'error'
        ? MessageTray.Urgency.HIGH
        : MessageTray.Urgency.NORMAL;
}

// One live notification. Kept deliberately thin: all it owns is the
// MessageTray.Notification and whether it is still alive.
class TrayHandle {
    constructor(notification) {
        this._notification = notification;
        notification.connect('destroy', () => {
            this._notification = null;
        });
    }

    update({ message, level }) {
        const n = this._notification;
        if (!n)
            return;   // already dismissed or evicted
        if (message != null)
            n.title = message;
        if (level) {
            n.urgency = _urgencyFor(level);
            if (!n.gicon)
                n.iconName = LEVEL_ICONS[level] ?? LEVEL_ICONS.info;
        }
        // Re-banner. Setting title alone updates the history entry silently;
        // only the acknowledged transition re-emits
        // 'notification-request-banner'.
        n.acknowledged = false;
    }

    dismiss() {
        this._notification?.destroy(
            MessageTray.NotificationDestroyedReason.DISMISSED);
        this._notification = null;
    }
}

export class TrayBackend {
    constructor() {
        this._source = null;
        this._historySize = 5;
        this._gicon = null;
    }

    /**
     * @param {{historySize?: number, gicon?: Gio.Icon}} opts
     */
    configure({ historySize, gicon } = {}) {
        if (historySize != null) {
            this._historySize = Math.max(1, Math.min(10, historySize));
            this._trim();
        }
        if (gicon !== undefined) {
            this._gicon = gicon;
            if (this._source)
                this._source.icon = gicon;
        }
    }

    _ensureSource() {
        if (this._source)
            return this._source;

        const source = new MessageTray.Source({
            title: 'Tailscale',
            icon: this._gicon ?? new Gio.ThemedIcon({ name: 'network-vpn-symbolic' }),
        });
        // A source that empties out destroys itself; hold no stale reference.
        source.connect('destroy', () => {
            if (this._source === source)
                this._source = null;
        });
        Main.messageTray.add(source);
        this._source = source;
        return source;
    }

    // Evict oldest-first down to the configured size. Called before every
    // insert and again from configure() so lowering the size takes effect at
    // once rather than on the next notification.
    _trim(headroom = 0) {
        const source = this._source;
        if (!source)
            return;
        while (source.notifications.length > Math.max(0, this._historySize - headroom)) {
            const [oldest] = source.notifications;
            oldest.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
            // Evicting the last one destroys the source; stop touching it.
            if (!this._source)
                return;
        }
    }

    /**
     * @param {{message: string, level?: string, gicon?: Gio.Icon}} opts
     * @returns {TrayHandle}
     */
    show({ message, level = 'info', gicon = null }) {
        // Make room first: evicting the last entry destroys the source, so
        // the source must be resolved *after* trimming or the notification
        // would be attached to a disposed one.
        this._trim(1);
        const source = this._ensureSource();

        const params = {
            source,
            title: message,
            urgency: _urgencyFor(level),
        };
        const icon = gicon ?? this._gicon;
        if (icon)
            params.gicon = icon;
        else
            params.iconName = LEVEL_ICONS[level] ?? LEVEL_ICONS.info;

        const notification = new MessageTray.Notification(params);
        source.addNotification(notification);
        return new TrayHandle(notification);
    }

    destroy() {
        // Destroying the source destroys every notification it holds.
        this._source?.destroy(
            MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._source = null;
        this._gicon = null;
    }
}
```

- [ ] **Step 2: Verify the syntax**

Run: `make test-syntax`
Expected: every file prints `OK`

- [ ] **Step 3: Confirm it is not yet referenced**

Run: `grep -rn "tray.js\|TrayBackend" --include="*.js" . | grep -v "^./lib/tray.js"`
Expected: no output. The module is inert until Task 7.

- [ ] **Step 4: Commit**

```bash
git add lib/tray.js
git commit -m "feat: add the persistent notification backend

Wraps a MessageTray.Source as a capped history: evicts oldest-first down to
the configured size, rebuilds the source after GNOME self-destructs it at
zero notifications, and re-banners updates via the acknowledged transition."
```

---

### Task 6: Add the toast render backend

**Files:**
- Modify: `lib/toast.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `ToastBackend` with `configure({durationMs})`, `show({message, level, gicon}) → handle`, `destroy()`; handle has `update({message, level})` and `dismiss()`.

`ToastManager` is kept exported and working for now so the extension still loads; Task 8 removes it once the call sites have moved.

This task is **purely additive**. `ToastManager` and the module state it uses
stay exactly as they are so the extension keeps loading; Task 8 deletes them
once no call site imports them. Do not remove anything here.

- [ ] **Step 1: Add the backend class**

In `lib/toast.js`, insert the following **immediately above** the existing
`export const ToastManager = { … };` block (currently line 238). Leave that
block untouched — the two coexist until Task 8.

```js
// Transient on-screen backend. Reduced to pure rendering: the policy layer
// in notify.js owns the GSettings subscription, the category filter, the
// quiet stack and withFeedback, and pushes the only value this module needs
// through configure().
export class ToastBackend {
    /** @param {{durationMs?: number, gicon?: Gio.Icon}} opts */
    configure({ durationMs, gicon } = {}) {
        if (durationMs != null)
            _settings.durationMs = durationMs;
        if (gicon !== undefined)
            _successGicon = gicon;
    }

    /**
     * @param {{message: string, level?: string, gicon?: Gio.Icon}} opts
     * @returns {Toast} handle with update({message, level}) and dismiss()
     */
    show({ message, level = 'info', gicon = null }) {
        const container = _ensureContainer();
        const toast = new Toast({ message, level, gicon });
        container.add_child(toast);
        _live.push(toast);
        _reposition();
        toast.present();
        return toast;
    }

    destroy() {
        if (_repositionId) {
            GLib.source_remove(_repositionId);
            _repositionId = 0;
        }
        // Destroying the container destroys every child toast; each one
        // removes its own auto-dismiss timeout in its 'destroy' handler.
        _live = [];
        if (_container) {
            Main.layoutManager.removeChrome(_container);
            _container.destroy();
            _container = null;
        }
        _successGicon = null;
    }
}
```

- [ ] **Step 2: Verify the syntax**

Run: `make test-syntax`
Expected: every file prints `OK`

- [ ] **Step 3: Confirm both APIs coexist**

Run: `grep -c "ToastBackend\|ToastManager" lib/toast.js`
Expected: a non-zero count for each — run
`grep -n "^export" lib/toast.js` and confirm both `export class ToastBackend`
and `export const ToastManager` are present.

- [ ] **Step 4: Verify the extension still loads**

Run:
```bash
make install
dbus-run-session -- gnome-shell --devkit
```
Expected: the Quick Settings tile still works and toasts still appear, exactly
as before this task. Nothing consumes `ToastBackend` yet.

- [ ] **Step 5: Commit**

```bash
git add lib/toast.js
git commit -m "feat(toast): add a render-backend API alongside ToastManager

ToastBackend exposes the configure/show/destroy contract shared with the
persistent backend, reusing the existing Toast actor and container.
ToastManager stays until the call sites move, so the extension keeps
loading at every commit."
```

---

### Task 7: The notification manager

**Files:**
- Create: `lib/notify.js`

**Interfaces:**
- Consumes: `NotifyPolicy`, `Category`, `CATEGORY_KEY`, `QuietScope` (Task 1); `TrayBackend` (Task 5); `ToastBackend` (Task 6).
- Produces: singleton `Notifier` with:
  - `init(settings, {extension})`
  - `notify({category, level, message, gicon, spontaneous, force}) → handle`
  - `withFeedback(category, pendingMsg, successMsg, fn) → Promise`
  - `beginQuiet(scope) → token`, `endQuiet(token)`
  - `get icon() → Gio.Icon|null`
  - `destroy()`
  - re-exports `Category` and `QuietScope` so call sites need one import.

- [ ] **Step 1: Write the manager**

`lib/notify.js`:

```js
// The one module notification call sites import.
//
// Decides whether a notification is allowed through (category filter and
// quiet windows, both in the pure notify-policy module), then routes it to
// whichever backend the user picked. Backends never read GSettings and never
// know about categories; this module pushes them what they need.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Category, CATEGORY_KEY, QuietScope, NotifyPolicy } from './notify-policy.js';
import { TrayBackend } from './tray.js';
import { ToastBackend } from './toast.js';

export { Category, QuietScope };

// Returned when a notification is filtered out, so callers can hold a handle
// unconditionally. Returning null instead would put a nullity check on every
// site that later calls update(), and one missed check is a TypeError inside
// a main-loop callback.
const NOOP_HANDLE = Object.freeze({
    update() {},
    dismiss() {},
    get isNoop() { return true; },
});

const MODE_PERSISTENT = 'persistent';

export const Notifier = {
    /**
     * @param {Gio.Settings} settings
     * @param {{extension?: object}} [opts]
     */
    init(settings, opts = {}) {
        this._settings = settings;
        this._policy = new NotifyPolicy();
        this._tray = new TrayBackend();
        this._toast = new ToastBackend();
        this._floorIds = new Set();
        this._gicon = null;

        if (opts.extension) {
            this._gicon = new Gio.FileIcon({
                file: opts.extension.dir
                    .get_child('icons')
                    .get_child('tailscale-symbolic.svg'),
            });
        }

        const refreshCategories = () => {
            for (const [category, key] of Object.entries(CATEGORY_KEY))
                this._policy.setCategoryEnabled(category, settings.get_boolean(key));
        };
        const refreshBackends = () => {
            this._tray.configure({
                historySize: settings.get_uint('notification-history-size'),
                gicon: this._gicon,
            });
            this._toast.configure({
                durationMs: settings.get_uint('toast-duration') * 1000,
                gicon: this._gicon,
            });
        };
        refreshCategories();
        refreshBackends();

        settings.connectObject(
            'changed::notification-history-size', refreshBackends,
            'changed::toast-duration',            refreshBackends,
            ...Object.values(CATEGORY_KEY).flatMap((key) => [
                `changed::${key}`,
                refreshCategories,
            ]),
            this,
        );
    },

    /** The Tailscale icon, or null before init(). */
    get icon() {
        return this._gicon;
    },

    get _backend() {
        return this._settings.get_string('notification-mode') === MODE_PERSISTENT
            ? this._tray
            : this._toast;
    },

    /**
     * @param {{category: string, message: string, level?: string,
     *          gicon?: Gio.Icon, spontaneous?: boolean, force?: boolean}} opts
     * @returns {{update: Function, dismiss: Function}} always a usable handle
     */
    notify({ category, message, level = 'info', gicon = null,
             spontaneous = false, force = false }) {
        if (!this._policy.shouldShow({ category, level, spontaneous, force }))
            return NOOP_HANDLE;
        return this._backend.show({ message, level, gicon });
    },

    /**
     * Open a quiet window. Callers must pair this with endQuiet().
     *
     * @param {string} scope one of QuietScope
     * @returns {number} token
     */
    beginQuiet(scope) {
        return this._policy.beginQuiet(scope);
    },

    endQuiet(token) {
        this._policy.endQuiet(token);
    },

    // Hold the pending state for at least the configured floor so an instant
    // operation does not flash from "doing it" to "done". Applies to both
    // modes: a native banner mutating in 80ms is just as unreadable as a
    // toast doing it.
    async _awaitFloor(startMs) {
        const floor = this._settings.get_uint('toast-min-spinner');
        const wait = floor - (GLib.get_monotonic_time() / 1000 - startMs);
        if (wait <= 0)
            return;
        await new Promise((resolve) => {
            const id = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, Math.ceil(wait), () => {
                    this._floorIds.delete(id);
                    resolve();
                    return GLib.SOURCE_REMOVE;
                });
            this._floorIds.add(id);
        });
    },

    /**
     * Run an async operation behind a pending notification that resolves in
     * place to success or error.
     *
     * @param {string} category one of Category
     * @param {string} pendingMsg
     * @param {string} successMsg
     * @param {() => Promise<{ok?: boolean, message?: string}|void>} fn
     */
    async withFeedback(category, pendingMsg, successMsg, fn) {
        const quiet = this.beginQuiet(QuietScope.SPONTANEOUS);
        let handle = this.notify({ category, level: 'pending', message: pendingMsg });
        const startMs = GLib.get_monotonic_time() / 1000;

        let result;
        try {
            result = await fn();
        } catch (e) {
            result = { ok: false, message: String(e.message ?? e) };
        }
        await this._awaitFloor(startMs);
        this.endQuiet(quiet);

        const failed = !!(result && result.ok === false);
        const level = failed ? 'error' : 'success';
        const message = failed
            ? (result.message || _('Operation failed'))
            : successMsg;

        // The pending state may have been filtered while the result is not:
        // muting a category still lets its failures through (notify-errors).
        // Create the notification late in that case rather than swallowing a
        // failure the user asked to see.
        if (handle.isNoop)
            handle = this.notify({ category, level, message });
        else
            handle.update({ level, message });

        return result;
    },

    destroy() {
        this._settings?.disconnectObject(this);
        for (const id of this._floorIds)
            GLib.source_remove(id);
        this._floorIds.clear();
        this._policy?.clearQuiet();
        this._tray?.destroy();
        this._toast?.destroy();
        this._tray = null;
        this._toast = null;
        this._policy = null;
        this._settings = null;
        this._gicon = null;
    },
};
```

- [ ] **Step 2: Verify the syntax**

Run: `make test-syntax`
Expected: every file prints `OK`

- [ ] **Step 3: Verify the policy still passes its tests**

Run: `make test`
Expected: `ok — 30 tests passed`

- [ ] **Step 4: Commit**

```bash
git add lib/notify.js
git commit -m "feat: add the notification manager

Routes notifications to the tray or toast backend after the policy filter,
owns the GSettings subscription for both, and moves withFeedback up from
toast.js. withFeedback re-checks the filter at resolution time so a failure
still surfaces when its pending state was suppressed by a muted category."
```

---

### Task 8: Migrate the call sites

**Files:**
- Modify: `extension.js` (import, `enable()`, `disable()`, and 15 call sites)
- Modify: `lib/menu.js` (import, 21 call sites, delete `spontaneous()`, `_maybeToastConnection`, `_maybeToastExitNodeChange` and their tracker fields)
- Modify: `lib/toast.js` (delete the `ToastManager` compatibility export if any remains)

**Interfaces:**
- Consumes: `Notifier`, `Category` from `lib/notify.js`; `SnapshotWatcher` from `lib/watchers.js`.
- Produces: no new exports.

- [ ] **Step 1: Swap the imports**

In `extension.js`, replace the `ToastManager` import with:

```js
import { Notifier, Category } from './lib/notify.js';
import { SnapshotWatcher } from './lib/watchers.js';
```

In `lib/menu.js`, replace the `ToastManager` import with:

```js
import { Notifier, Category } from './notify.js';
```

In `extension.js` `enable()`, replace `ToastManager.init(this._settings, { extension: this });` with:

```js
        Notifier.init(this._settings, { extension: this });
```

In `extension.js` `disable()`, replace the `ToastManager.destroy()` call with `Notifier.destroy();`.

- [ ] **Step 2: Migrate `extension.js`**

Every `ToastManager.show({...})` becomes `Notifier.notify({ category: …, ... })` and every `ToastManager.withFeedback(p, s, fn)` becomes `Notifier.withFeedback(category, p, s, fn)`. Exact mapping, by the line numbers at `ff1d842`:

| Line | Call | Category |
|---|---|---|
| 94 | `show` — `Profile preferences applied` | `Category.PROFILE_SWITCH`, plus `force: true` |
| 277 | `show` — `${meta.label}: enabled/disabled` | `Category.NETWORK` |
| 286 | `show` — `${meta.label}: enabled` | `Category.NETWORK` |
| 297 | `withFeedback` — `turning on` | `Category.NETWORK` |
| 311 | `show` — `${meta.label}: disabled` | `Category.NETWORK` |
| 317 | `withFeedback` — `turning off` | `Category.NETWORK` |
| 346 | `show` — Taildrop / Funnel feature flip | `Category.NETWORK` |
| 457 | `show` — `Login required` | `Category.CONNECTION` |
| 461 | `show` — `Tailscale is not ready yet` | `Category.CONNECTION` |
| 465 | `withFeedback` — `Disconnecting Tailscale` | `Category.CONNECTION` |
| 471 | `withFeedback` — `Connecting Tailscale` | `Category.CONNECTION` |
| 482 | `withFeedback` — `Clearing exit node` | `Category.EXIT_NODE` |
| 488 | `withFeedback` — `Selecting an exit node` | `Category.EXIT_NODE` |

Line 94 is the account-switch summary and is the only `force: true` in the codebase:

```js
                Notifier.notify({
                    category: Category.PROFILE_SWITCH,
                    level: 'success',
                    force: true,
                    message: `${_('Profile preferences applied')} (${accountName})`,
                });
```

- [ ] **Step 3: Migrate `lib/menu.js`**

Same transformation. `this._withFeedback(p, s, fn)` gains a leading category argument, and its body (line 1834) becomes:

```js
        _withFeedback(category, pending, success, fn) {
            return Notifier.withFeedback(category, pending, success, fn);
        }
```

Exact mapping, by the line numbers at `ff1d842`:

| Line | Call | Category |
|---|---|---|
| 64 | `show` — `Could not open %s` | `Category.ERRORS` |
| 662 | `show` — `Status refreshed` | `Category.MISC` |
| 737 | `_withFeedback` — Magic DNS | `Category.NETWORK` |
| 747 | `_withFeedback` — Accept routes | `Category.NETWORK` |
| 761 | `_withFeedback` — Shields up | `Category.NETWORK` |
| 770 | `_withFeedback` — SSH server | `Category.NETWORK` |
| 897 | `_withFeedback` — `Granting operator privilege` | `Category.ACCOUNT` |
| 928 | `show` — `Login required (see Account menu)` | `Category.CONNECTION` |
| 940 | `show` — `_statusText(snap)` | `Category.CONNECTION` |
| 948 | `_withFeedback` — `Connecting Tailscale` | `Category.CONNECTION` |
| 954 | `_withFeedback` — `Disconnecting Tailscale` | `Category.CONNECTION` |
| 1221 | `_withFeedback` — `Removing funnel on port %d` | `Category.FUNNEL` |
| 1238 | `show` — `All Funnel ports are in use` | `Category.FUNNEL` |
| 1256 | `show` — `Invalid port number` | `Category.FUNNEL` |
| 1267 | `_withFeedback` — `Adding funnel on port %d` | `Category.FUNNEL` |
| 1285 | `show` — `Could not open %s` | `Category.FUNNEL` |
| 1290 | `show` — `Approve Funnel in the browser` | `Category.FUNNEL` |
| 1412 | `_withFeedback` — `Clearing exit node` | `Category.EXIT_NODE` |
| 1423 | `_withFeedback` — `Selecting an exit node` | `Category.EXIT_NODE` |
| 1461 | `_withFeedback` — `Routing through %s` | `Category.EXIT_NODE` |
| 1479 | `_withFeedback` — LAN access | `Category.NETWORK` |
| 1578 | `_withFeedback` — `Switching to %s` | `Category.PROFILE_SWITCH` |
| 1610 | `_withFeedback` — `Opening Tailscale login` | `Category.ACCOUNT` |
| 1626 | `_withFeedback` — `Logging out` | `Category.ACCOUNT` |
| 1675 | `show` — Taildrop receiver on/off | `Category.TAILDROP` |
| 1696 | `show` — `Taildrop is disabled … by your admin` | `Category.TAILDROP` |
| 1704 | `show` — `No online peers available` | `Category.TAILDROP` |
| 1719 | `_withFeedback` — `Sending %s to %s` | `Category.TAILDROP` |
| 1804 | `show` — `File chooser portal unavailable` | `Category.ERRORS` |
| 1844 | `show` — `Copied %s to clipboard` | `Category.MISC` |

- [ ] **Step 4: Replace the daemon-signal helper**

In `lib/menu.js`, delete the `spontaneous` helper (lines 617-619) and rewrite the two signal connections that used it so the flag travels with the notification instead of being checked at the call site:

```js
            this._client.connectObject(
                'state-changed', (_c, snap) => this._render(snap),
                'error', (_c, msg) => Notifier.notify({
                    category: Category.ERRORS,
                    level: 'error',
                    message: msg,
                    spontaneous: true,
                }),
                'notify-info', (_c, msg) => Notifier.notify({
                    category: Category.CONNECTION,
                    level: 'success',
                    message: msg,
                    spontaneous: true,
                }),
                this,
```

- [ ] **Step 5: Delete the watcher code from `lib/menu.js`**

Remove entirely:
- `_maybeToastExitNodeChange` (lines 970-1014) and its call in `_render` (line 1058).
- `_maybeToastConnection` (lines 1016-1053) and its call in `_render` (line 1057).
- The tracker assignment block `this._exitTrack = { … };` (lines 1061-1070).
- The three constructor fields `this._exitTrack`, `this._lastBackendState`, `this._connToast` (lines 615-617).

- [ ] **Step 6: Wire the watchers in `extension.js`**

In `enable()`, after the client is constructed and before `this._client.start();`, add:

```js
        // Snapshot-derived notifications. The watcher is a pure diff; this
        // table is where its events become user-facing copy, which is why
        // watchers.js carries no gettext import.
        const WATCHER_COPY = {
            'connection-starting':   () => _('Connecting Tailscale — this may take a moment'),
            'connection-established': () => _('Tailscale connected'),
            'connection-ended':      () => _('Tailscale disconnected'),
            'exit-node-lost':        () => _('Auto exit node lost'),
            'exit-node-acquired':    (d) => `${_('Auto exit node')}: ${d.name}`,
            'exit-node-switched':    (d) => `${_('Auto exit node switched to')} ${d.name}`,
            'exit-node-offline':     (d) => `${_('Exit node went offline')}: ${d.name}`,
            'exit-node-online':      (d) => `${_('Exit node is back online')}: ${d.name}`,
            'exit-node-disabled':    (d) => `${_('Exit node was disabled')}: ${d.name}`,
            'exit-node-reenabled':   (d) => `${_('Exit node was re-enabled')}: ${d.name}`,
        };

        this._watcher = new SnapshotWatcher();
        // A pending connection resolves in place, so its handle outlives the
        // event that created it.
        this._connHandle = null;
        this._client.connectObject('state-changed', (_c, snap) => {
            for (const ev of this._watcher.feed(snap)) {
                const message = WATCHER_COPY[ev.type](ev.data);
                if (ev.type === 'connection-starting') {
                    this._connHandle = Notifier.notify({
                        category: ev.category,
                        level: ev.level,
                        message,
                        spontaneous: true,
                        gicon: Notifier.icon,
                    });
                    continue;
                }
                if (this._connHandle && ev.type.startsWith('connection-')) {
                    this._connHandle.update({ level: ev.level, message });
                    this._connHandle = null;
                    continue;
                }
                Notifier.notify({
                    category: ev.category,
                    level: ev.level,
                    message,
                    spontaneous: true,
                    gicon: Notifier.icon,
                });
            }
        }, this);
```

In `disable()`, add `this._connHandle = null;` and `this._watcher = null;` alongside the other teardown.

- [ ] **Step 7: Delete the superseded toast API**

No call site imports `ToastManager` any more, so remove from `lib/toast.js`:

- the whole `export const ToastManager = { … };` block;
- the two module-level declarations only it used:

```js
let _activeOps = 0;
const _floorTimeoutIds = new Set();
```

- the `minSpinnerMs` property of `_settings`, whose floor now lives in
  `notify.js`. Update the surviving declaration to read:

```js
// Pushed in by notify.js via ToastBackend.configure(); this module never
// reads GSettings itself.
const _settings = {
    durationMs: 3000,
};
```

- [ ] **Step 8: Verify nothing still references the old API**

Run: `grep -rn "ToastManager\|hasActiveOp\|_maybeToast\|_activeOps\|_floorTimeoutIds\|minSpinnerMs\|spontaneous(" --include="*.js" .`
Expected: no output.

- [ ] **Step 9: Verify the syntax and tests**

Run: `make test-syntax && make test`
Expected: every file `OK`, then `ok — 30 tests passed`

- [ ] **Step 10: Verify the extension loads**

Run:
```bash
make install
dbus-run-session -- gnome-shell --devkit
```
Expected: the Quick Settings tile appears; toggling Magic DNS produces one notification under a **Tailscale** group in the notification list. Watch the log for `JS ERROR` — there must be none.

- [ ] **Step 11: Commit**

```bash
git add extension.js lib/menu.js lib/toast.js
git commit -m "refactor: route every notification through the policy layer

Migrates all 36 call sites onto Notifier with an explicit category, moves
the snapshot watchers out of menu.js, and replaces the three scattered
hasActiveOp checks with a spontaneous flag carried by the notification."
```

---

### Task 9: Account-switch quiet window

**Files:**
- Modify: `extension.js` (open and close the window around the switch)
- Modify: `lib/per-account.js` (notify the extension when a slot apply starts)

**Interfaces:**
- Consumes: `Notifier.beginQuiet` / `endQuiet`, `QuietScope` from `lib/notify.js`.
- Produces: no new exports. `PerAccountFeatureState` gains an `onSlotLoading` constructor callback.

- [ ] **Step 1: Signal the start of a switch**

In `lib/per-account.js`, extend the constructor signature and store the new callback:

```js
    /**
     * @param {Gio.Settings} settings
     * @param {TailscaleClient} client  Emits 'state-changed' with the snapshot.
     * @param {{onSlotLoading?: (accountName: string) => void,
     *          onSlotLoaded?: (accountName: string) => void}} [hooks]
     *   onSlotLoading fires before a slot is applied, onSlotLoaded after.
     *   The pair brackets the burst of settings writes and daemon churn a
     *   switch produces, so the caller can mute it and report once.
     */
    constructor(settings, client, hooks = {}) {
        this._settings = settings;
        this._client = client;
        this._onSlotLoading = hooks.onSlotLoading ?? null;
        this._onSlotLoaded = hooks.onSlotLoaded ?? null;
```

In `_onSnapshot`, call the new hook just before the slot is applied:

```js
        if (!isFirstObservation && this._onSlotLoading)
            this._onSlotLoading(acc);

        this._currentAccount = acc;
        this._loadSlot(acc);
```

- [ ] **Step 2: Bracket the switch in `extension.js`**

Replace the `new PerAccountFeatureState(...)` call with:

```js
        // Mute the burst an account switch produces — the bulk feature-*
        // apply, the daemon churn that follows, and the exit-node and
        // backend-state transitions the new tailnet brings with it — and
        // report the outcome once.
        //
        // The window is closed by a debounce re-armed on every snapshot, so
        // it survives a slow daemon, and by a hard ceiling so a daemon that
        // never settles cannot leave the extension permanently silent. Both
        // sources are cleared before re-arming and removed in disable().
        this._quietToken = 0;
        this._quietDebounceId = 0;
        this._quietCeilingId = 0;

        const closeQuiet = () => {
            if (this._quietDebounceId) {
                GLib.source_remove(this._quietDebounceId);
                this._quietDebounceId = 0;
            }
            if (this._quietCeilingId) {
                GLib.source_remove(this._quietCeilingId);
                this._quietCeilingId = 0;
            }
            if (this._quietToken) {
                Notifier.endQuiet(this._quietToken);
                this._quietToken = 0;
            }
        };

        const armQuietDebounce = () => {
            if (!this._quietToken) return;
            if (this._quietDebounceId) {
                GLib.source_remove(this._quietDebounceId);
                this._quietDebounceId = 0;
            }
            const settleMs = this._settings.get_int('poll-interval') * 2000;
            this._quietDebounceId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, settleMs, () => {
                    this._quietDebounceId = 0;
                    closeQuiet();
                    return GLib.SOURCE_REMOVE;
                });
        };

        this._perAccount = new PerAccountFeatureState(
            this._settings,
            this._client,
            {
                onSlotLoading: () => {
                    closeQuiet();   // a switch during a switch restarts the window
                    this._quietToken = Notifier.beginQuiet(QuietScope.ALL);
                    this._quietCeilingId = GLib.timeout_add_seconds(
                        GLib.PRIORITY_DEFAULT, 30, () => {
                            this._quietCeilingId = 0;
                            closeQuiet();
                            return GLib.SOURCE_REMOVE;
                        });
                    armQuietDebounce();
                },
                onSlotLoaded: (accountName) => {
                    Notifier.notify({
                        category: Category.PROFILE_SWITCH,
                        level: 'success',
                        force: true,
                        message: `${_('Profile applied')} (${accountName})`,
                    });
                    // Daemon side-effects (drift correction for OFF toggles)
                    // are normally driven by handleFeatureToggled, which the
                    // quiet window suppresses. Trigger them here.
                    this._client.refresh().catch(() => {});
                },
            },
        );

        // Every snapshot during the window pushes the close back, so the
        // window lasts as long as the daemon keeps changing its mind.
        this._client.connectObject(
            'state-changed', () => armQuietDebounce(),
            this,
        );
```

Add `QuietScope` to the `lib/notify.js` import in `extension.js`:

```js
import { Notifier, Category, QuietScope } from './lib/notify.js';
```

- [ ] **Step 3: Tear down in `disable()`**

In `disable()`, before `Notifier.destroy()`, add:

```js
        if (this._quietDebounceId) {
            GLib.source_remove(this._quietDebounceId);
            this._quietDebounceId = 0;
        }
        if (this._quietCeilingId) {
            GLib.source_remove(this._quietCeilingId);
            this._quietCeilingId = 0;
        }
        this._quietToken = 0;
```

- [ ] **Step 4: Verify the syntax**

Run: `make test-syntax`
Expected: every file prints `OK`

- [ ] **Step 5: Verify no timeout can leak**

Run: `grep -n "_quietDebounceId\|_quietCeilingId" extension.js`
Expected: each id appears in exactly four places — declaration, arm, clear-before-rearm or clear-on-close, and `disable()`. Every `GLib.timeout_add` assignment must be preceded by a `GLib.source_remove` guard on the same field.

- [ ] **Step 6: Verify the behaviour**

Run:
```bash
make install
dbus-run-session -- gnome-shell --devkit
```
Then switch account from the menu. Expected: exactly **one** notification, `Profile applied (<tailnet>)`. Before this task the same action produced a burst.

- [ ] **Step 7: Commit**

```bash
git add extension.js lib/per-account.js
git commit -m "fix: collapse the account-switch notification burst

Brackets the slot apply and the daemon churn that follows in an all-scope
quiet window, closed by a debounce re-armed on every snapshot and by a hard
30s ceiling so a daemon that never settles cannot leave the extension
silent. Both sources are cleared before re-arming and removed in disable()."
```

---

### Task 10: Dead-code sweep and verification

**Files:**
- Modify: whichever files the sweep turns up
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new.

- [ ] **Step 1: Find unused exports**

Run:
```bash
for f in lib/*.js; do
  grep -oP '^export (const|function|class|let) \K\w+' "$f" | while read -r sym; do
    n=$(grep -rn "\b$sym\b" --include="*.js" . | grep -v "^$f:" | wc -l)
    [ "$n" -eq 0 ] && echo "UNUSED  $f  $sym"
  done
done
```
Expected: no output. Delete anything reported.

- [ ] **Step 2: Find unused schema keys**

Run:
```bash
grep -oP '<key name="\K[^"]+' schemas/*.gschema.xml | while read -r k; do
  n=$(grep -rn "'$k'\|\"$k\"" --include="*.js" . | wc -l)
  [ "$n" -eq 0 ] && echo "UNUSED KEY  $k"
done
```
Expected: no output. `feature-state-per-account` is referenced from `lib/per-account.js:6` and stays — it is Spec 2's business, not this one's.

- [ ] **Step 3: Find unused CSS classes**

Run:
```bash
grep -oP '^\.\K[a-z0-9-]+' stylesheet.css | sort -u | while read -r c; do
  n=$(grep -rn "$c" --include="*.js" . | wc -l)
  [ "$n" -eq 0 ] && echo "UNUSED CSS  .$c"
done
```
Expected: no output. The `.tailscale-osd-*` classes are still used by toast mode; anything else reported should be deleted from `stylesheet.css`.

- [ ] **Step 4: Run the full verification**

Run:
```bash
make test && make test-syntax && make pack && shexli tailscale-gnome@diskmth.fr.shell-extension.zip
```
Expected: tests pass, every file `OK`, and shexli reports **0 errors, 0 warnings** with the single clipboard `manual_review` — identical to the `ff1d842` baseline.

- [ ] **Step 5: Confirm the tests are not shipped**

Run: `unzip -l tailscale-gnome@diskmth.fr.shell-extension.zip | grep -c tests`
Expected: `0`

- [ ] **Step 6: Work the manual checklist**

Run `make install` then `dbus-run-session -- gnome-shell --devkit` and walk every row of §11 of the spec. All 17 scenarios must pass. Row 16 — disabling the extension mid-operation with no residual timeout or source — is the defect class behind both prior EGO rejections and must not be skipped.

- [ ] **Step 7: Update the changelog**

Add a new section at the top of `CHANGELOG.md`, above the most recent release, matching the file's existing heading style:

```markdown
## Unreleased

### Added
- Two notification modes, selectable in a new Notifications preferences page.
  Persistent mode (the default) posts native GNOME notifications that stack
  into a browsable history under a single Tailscale entry, capped at a
  configurable 1–10 entries. Toast mode keeps the previous transient bubble.
- Nine per-category switches controlling which events may notify, plus a
  failures override that lets errors through even when their category is off.

### Fixed
- Switching accounts produced a burst of notifications, one per setting that
  flipped. It now reports once, when the new profile has been applied.

### Changed
- Toast duration and minimum pending duration moved from the General page to
  the new Notifications page.
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: dead-code sweep and changelog for the notification rewrite

Cross-checked exports against imports, schema keys against reads, and CSS
classes against style_class. shexli on the packaged zip matches the ff1d842
baseline: 0 errors, 0 warnings."
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
|---|---|
| §2 verified GNOME facts | 5 (source rebuild, eviction, acknowledged re-banner) |
| §3 architecture, 4 modules | 1, 2, 5, 6, 7 |
| §3.1 backend contract, `configure()` | 5, 6, 7 |
| §3.2 no-op handle | 7 |
| §3.3 `withFeedback` moves up, floor in both modes | 7 |
| §4 persistent backend | 5 |
| §5 toast reduced to a backend | 6 |
| §6 schema | 3 |
| §7 category × level rule | 1 (logic), 4 (prefs copy) |
| §7.1 call-site mapping | 8 |
| §8 quiet window, debounce, hard ceiling | 9 |
| §8.3 five guards removed | 8 (three), 9 (two) |
| §9 `watchers.js` | 2 (pure core), 8 (wiring) |
| §10 simplifications and sweep | 8, 10 |
| §11 verification | 10 |
| §12 out of scope | untouched by design; Task 10 Step 2 explicitly protects `feature-state-per-account` |

No gaps.

**Placeholder scan:** none — every code step carries complete source, every command carries its expected output.

**Type consistency:** `Category` and `QuietScope` are defined once in Task 1 and re-exported from `notify.js` in Task 7, so call sites import from one place. The backend contract (`configure` / `show` / `destroy`, handle `update` / `dismiss`) is identical in Tasks 5, 6 and 7. `SnapshotWatcher.feed()` returns the event array consumed in Task 8 Step 6. `PerAccountFeatureState`'s third constructor argument changes from a bare function to a `{onSlotLoading, onSlotLoaded}` object in Task 9 — the only signature change to existing code, and its single call site is updated in the same task.

**One deviation from the spec, deliberate:** §3 describes `notify.js` as the policy layer. The plan splits it into `notify-policy.js` (pure rules) and `notify.js` (wiring). The reason is verified rather than assumed: `gjs -m` loads `gi://` modules but fails on `resource:///org/gnome/shell/…`, so any file importing Shell APIs is untestable. Splitting the rules out is what makes Task 1's twelve tests possible at all.
