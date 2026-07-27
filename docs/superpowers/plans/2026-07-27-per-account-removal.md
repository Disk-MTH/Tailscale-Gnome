# Per-Account State Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the extension's per-tailnet feature-state duplication, which `tailscaled` already provides per profile, and turn the account switch into a snapshot-diff event.

**Architecture:** `lib/per-account.js` disappears entirely. The account switch it detected becomes an `account-switched` event emitted by `lib/watchers.js`, which `extension.js` uses to open the quiet window, re-probe availability and report once. Feature toggles lose their save/restore state and their continuous drift correction: turning a feature off resets the daemon once, at click time; turning it back on restores nothing. With the account-switch quiet window narrowed to spontaneous notifications, `QuietScope` and the `force` flag lose their last callers and are removed.

**Tech Stack:** GJS (GNOME Shell 45+ ESM), GSettings/gschema XML, GNOME Shell 50 APIs, a dependency-free test harness under `tests/` run by `make test`.

**Spec:** `docs/superpowers/specs/2026-07-27-per-account-removal-design.md`

## Global Constraints

- All shipped artefacts — code, comments, translatable strings, README, CHANGELOG — are **in English**. Only the spec and plan documents are French.
- `lib/watchers.js` and `lib/notify-policy.js` must never import `resource:///org/gnome/shell/…` nor `gettext`. That is what lets `make test` exercise them outside a Shell session. Events carry data, never user-facing text.
- Timeout sources: store the id, set the field to `0` **before** re-arming, and remove every source in `disable()`. This is the `clear-before-rearm` lesson from the v0.2.1 Taildrop fix and the class of defect behind both EGO rejections.
- `make test` and `make test-syntax` must pass at the end of every task.
- Final reference not to degrade: `make pack && shexli tailscale-gnome@diskmth.fr.shell-extension.zip` → **0 errors, 0 warnings**, one `manual_review` (clipboard access, already declared in `metadata.json`).
- Commit after every task. Conventional-commit prefixes, as in the existing history (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`).

---

### Task 1: `account-switched` in `lib/watchers.js`

The account switch is a snapshot diff like any other. Detecting it belongs in the module whose single responsibility is turning diffs into semantic events — and being import-free, it is the only part of this change that can be unit-tested.

**Files:**
- Modify: `lib/watchers.js:15-24` (`EMPTY_TRACK`), `:40-50` (`_event`), `:122-144` (`computeEvents`)
- Test: `tests/watchers.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: an event object `{ type: 'account-switched', category: 'profile-switch', level: 'success', spontaneous: false, data: { name: string } }`, emitted at most once per `computeEvents()` call and always **first** in the returned array. Task 2 consumes it.

- [ ] **Step 1: Write the failing tests**

Add to `tests/watchers.test.js`. First extend the shared `snapshot` factory (`:9-15`) with the new field:

```js
const snapshot = (over = {}) => ({
    backendState: 'Running',
    exitNodeID: null,
    autoExitNode: false,
    currentExitNode: null,
    accountName: null,
    ...over,
});
```

Then append a new suite at the end of the file:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rtk make test`
Expected: FAIL — the five new cases report `[]` or a missing event; the existing 32 still pass.

- [ ] **Step 3: Implement**

In `lib/watchers.js`, add the field to `EMPTY_TRACK`:

```js
export const EMPTY_TRACK = Object.freeze({
    backendState:    null,
    pendingConnection: false,
    seeded:          false,
    accountName:     null,
    autoExitNode:    null,
    effectiveNodeId: null,
    exitNodeID:      null,
    nodeOnline:      null,
    nodeOption:      null,
});
```

Give `_event` an override argument — the category-from-prefix rule and the spontaneous default hold for every event except this one:

```js
function _event(type, level, data = {}, over = {}) {
    return {
        type,
        category: type.startsWith('connection-')
            ? Category.CONNECTION
            : Category.EXIT_NODE,
        level,
        spontaneous: true,
        data,
        ...over,
    };
}
```

Add the detector above `_connectionEvents`:

```js
// An account switch is a report, not background noise: it is the only event
// here that is not spontaneous, because it answers something the user (or
// `tailscale switch`) did.
function _accountEvents(track, snap, out) {
    if (!track.seeded)
        return;
    if (!snap.accountName)
        return;
    if (snap.accountName === track.accountName)
        return;
    out.push(_event('account-switched', 'success', { name: snap.accountName }, {
        category: Category.PROFILE_SWITCH,
        spontaneous: false,
    }));
}
```

Wire it first in `computeEvents`, and carry the last known name forward across nameless snapshots:

```js
    const events = [];
    _accountEvents(track, snap, events);
    const pendingConnection = _connectionEvents(track, snap, events);
    _exitNodeEvents(track, snap, events);

    const curr = snap.currentExitNode;
    return {
        events,
        track: {
            backendState:      snap.backendState,
            pendingConnection,
            seeded:            true,
            // Keep the last named tailnet: a logged-out snapshot must not
            // make the next login look like a switch.
            accountName:       snap.accountName || track.accountName,
            autoExitNode:      snap.autoExitNode,
            effectiveNodeId:   _effectiveId(curr),
            exitNodeID:        snap.exitNodeID,
            nodeOnline:        curr?.online ?? null,
            nodeOption:        curr?.exitNodeOption ?? null,
        },
    };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rtk make test`
Expected: PASS — 37 tests.

- [ ] **Step 5: Commit**

```bash
rtk git add lib/watchers.js tests/watchers.test.js
rtk git commit -m "feat(watchers): emit account-switched from the snapshot diff"
```

---

### Task 2: Retire `per-account.js` and rewire the switch

Deleting the module and wiring its replacement is one deliverable: any intermediate state either reports the switch twice or not at all.

**Files:**
- Delete: `lib/per-account.js`
- Modify: `extension.js:15-17` (imports), `:88-133` (copy table + event loop), `:137-236` (quiet-window helpers and the `PerAccountFeatureState` block), `:250-263` (`_lastAccountName` tracker), `:542-543` (`disable()`)
- Modify: `schemas/org.gnome.shell.extensions.tailscale-gnome.gschema.xml:149-158`

**Interfaces:**
- Consumes: the `account-switched` event from Task 1 — `{ type, category, level, spontaneous, data: { name } }`.
- Produces: `openQuietWindow()`, a local arrow in `enable()` that opens a `QuietScope.SPONTANEOUS` window with a debounced close and a 30 s hard ceiling. Task 4 drops its `QuietScope` argument.

- [ ] **Step 1: Move the quiet-window helpers above the watcher wiring**

They are currently declared at `:153-185`, after the `state-changed` handler at `:107` that will now call them. `this._client.start()` runs at `:135`, so a snapshot can arrive before a `const` declared further down is initialised. Cut the `this._quietToken = 0; this._quietDebounceId = 0; this._quietCeilingId = 0;` triple and the `closeQuiet` / `armQuietDebounce` definitions verbatim, and paste them immediately **before** `this._watcher = new SnapshotWatcher();` (`:103`). Then add the third helper after `armQuietDebounce`:

```js
        // Opened on an account switch: the daemon churns for a few seconds
        // afterwards (exit node, backendState) and none of that noise is worth
        // reporting. Closed by a debounce re-armed on every snapshot, so it
        // survives a slow daemon, and by a hard ceiling so a daemon that never
        // settles cannot leave the extension permanently silent.
        const openQuietWindow = () => {
            closeQuiet();   // a switch during a switch restarts the window
            this._quietToken = Notifier.beginQuiet(QuietScope.SPONTANEOUS);
            this._quietCeilingId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT, 30, () => {
                    this._quietCeilingId = 0;
                    closeQuiet();
                    return GLib.SOURCE_REMOVE;
                });
            armQuietDebounce();
        };
```

- [ ] **Step 2: Add the copy entry and rewire the event loop**

Append to `WATCHER_COPY` (`:88-101`) — this is the only place the event type becomes translatable text:

```js
            'account-switched':      (d) => _fmt(_('Profile applied (%s)'), d.name),
```

Replace the loop body (`:107-133`) so it honours `ev.spontaneous` instead of hard-coding `true`, and give the account event its branch:

```js
        this._client.connectObject('state-changed', (_c, snap) => {
            for (const ev of this._watcher.feed(snap)) {
                const message = WATCHER_COPY[ev.type](ev.data);
                if (ev.type === 'account-switched') {
                    // Unconditional: the daemon churns after a switch whoever
                    // started it, and admin ACLs differ per tailnet so the
                    // availability cache cannot be assumed to carry over.
                    openQuietWindow();
                    this._client.probeAvailability().catch(() => {});
                    // A menu-driven switch is already reported by its own
                    // withFeedback. An external `tailscale switch` has none, so
                    // there this notification is the only account of it.
                    if (Notifier.isCategoryBusy(Category.PROFILE_SWITCH))
                        continue;
                }
                if (ev.type === 'connection-starting') {
                    this._connHandle = Notifier.notify({
                        category: ev.category,
                        level: ev.level,
                        message,
                        spontaneous: ev.spontaneous,
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
                    spontaneous: ev.spontaneous,
                    gicon: Notifier.icon,
                });
            }
        }, this);
```

- [ ] **Step 3: Delete the per-account block and the account tracker**

Remove, in `extension.js`:

- the import `import { PerAccountFeatureState } from './lib/per-account.js';` (`:17`);
- the whole `this._perAccount = new PerAccountFeatureState(…);` statement with both hooks (`:187-229`) and the comment block above it (`:137-152`);
- the `_lastAccountName` declaration and its `state-changed` handler (`:250-263`), now redundant with the event branch — **keep** the startup `_availabilityProbeId` timeout above it (`:244-249`) untouched;
- the two guards that read the deleted object — `if (this._perAccount.isLoadingSlot) return;` at `:400` and at `:480`, each with the comment above it. Leaving either would throw on the first feature toggle. Task 3 rewrites both surrounding handlers; deleting the guards here keeps the tree runnable in between;
- in `disable()`, the two lines `this._perAccount.destroy(); this._perAccount = null;` (`:542-543`).

**Keep** the `state-changed` → `armQuietDebounce()` subscription (`:233-236`): every snapshot during the window still pushes its close back.

Then delete the module:

```bash
rm lib/per-account.js
```

- [ ] **Step 4: Drop the schema key**

Delete the `feature-state-per-account` key block (`:149-158`) from `schemas/org.gnome.shell.extensions.tailscale-gnome.gschema.xml`, then recompile:

Run: `rtk make schemas`
Expected: no error.

- [ ] **Step 5: Verify**

```bash
rtk make test-syntax
rtk make test
rg -n 'per-account|PerAccountFeatureState|isLoadingSlot|_lastAccountName|feature-state-per-account' extension.js lib/ schemas/ prefs.js
```

Expected: syntax OK on every file, 37 tests pass, and the `rg` call returns **no match**.

- [ ] **Step 6: Commit**

```bash
rtk git add -A extension.js lib/ schemas/
rtk git commit -m "refactor: drive the account switch from watchers, drop per-account.js"
```

---

### Task 3: One-shot feature reset, no drift correction

`ensureFeatureCompliance` ran on every snapshot and forced the daemon to obey the extension's display toggles — overwriting the preferences `tailscaled` had just restored for the incoming profile. It goes, along with the five `-saved` backup keys whose only purpose was undoing a toggle.

**Files:**
- Modify: `extension.js:315-491` (`FEATURE_META`, `ensureFeatureCompliance`, `handleFeatureToggled`, both `connectObject` blocks)
- Modify: `schemas/org.gnome.shell.extensions.tailscale-gnome.gschema.xml:108-130`

**Interfaces:**
- Consumes: `Notifier.notify`, `Notifier.withFeedback`, `Category.NETWORK`, `Category.ERRORS` — unchanged signatures.
- Produces: a single `FEATURE_META` table keyed by gschema key, each entry `{ label: string, isSet: (snap) => boolean, reset: ((client) => Promise)|null }`, and one `handleFeatureToggled(key)` covering all seven features.

- [ ] **Step 1: Replace `FEATURE_META`**

The old shape carried `savedKey`, `type`, `snapKey` and `set` because it had to read, store and restore a value. Nothing is stored any more, so an entry only needs to answer "is there anything to switch off?" and "switch it off". Replace the whole table (`:325-361`) — including the comment block above it (`:315-324`) — with:

```js
        /* -------------------- feature reset on disable -------------------- */
        // A feature toggled OFF in prefs must also switch the underlying
        // tailscale setting off — hiding the menu alone would leave it active
        // (accept-routes still letting traffic through, for instance). That
        // happens once, at click time.
        //
        // Nothing is saved: tailscaled persists these per profile and restores
        // them itself on `tailscale switch`, so re-enabling a feature simply
        // shows whatever the daemon has. The extension keeps no shadow copy to
        // disagree with.
        const FEATURE_META = {
            'feature-exit-nodes': {
                label: _('Exit nodes'),
                // Auto mode routes without an explicit exitNodeID, so both have
                // to be clear before the reset can be skipped.
                isSet: (snap) => !!(snap.exitNodeID || snap.autoExitNode),
                reset: (c) => c.setExitNode(''),
            },
            'feature-dns': {
                label: _('Magic DNS'),
                isSet: (snap) => !!snap.acceptDNS,
                reset: (c) => c.setAcceptDNS(false),
            },
            'feature-routes': {
                label: _('Subnet routes'),
                isSet: (snap) => !!snap.acceptRoutes,
                reset: (c) => c.setAcceptRoutes(false),
            },
            'feature-shields-up': {
                label: _('Shields up'),
                isSet: (snap) => !!snap.shieldsUp,
                reset: (c) => c.setShieldsUp(false),
            },
            'feature-ssh-server': {
                label: _('Tailscale SSH'),
                isSet: (snap) => !!snap.runSSH,
                reset: (c) => c.setRunSSH(false),
            },
            'feature-funnels': {
                label: _('Funnel'),
                isSet: (snap) => (snap.funnels?.length ?? 0) > 0,
                reset: (c) => c.resetFunnels(),
            },
            'feature-taildrop': {
                label: _('Taildrop'),
                // No daemon state of its own: syncTaildrop already stops the
                // receiver when this key goes false.
                isSet: () => false,
                reset: null,
            },
        };
```

- [ ] **Step 2: Delete `ensureFeatureCompliance`**

Remove the function and its subscription (`:363-388`) outright. Its two remaining jobs are now handled at click time: the exit-node auto case by `isSet` above, the funnel teardown by the `feature-funnels` entry.

- [ ] **Step 3: Replace `handleFeatureToggled` and collapse the two subscriptions into one**

Replace `handleFeatureToggled` (`:390-460`), its `connectObject` (`:462-468`) and the separate Taildrop/Funnel block (`:470-491`) with:

```js
        // One notification for the flip itself, then — only when switching a
        // feature off — a single daemon reset behind a pending notification.
        const handleFeatureToggled = (key) => {
            const meta = FEATURE_META[key];
            const enabled = this._settings.get_boolean(key);
            Notifier.notify({
                category: Category.NETWORK,
                level: 'success',
                message: `${meta.label}: ${enabled ? _('enabled') : _('disabled')}`,
            });
            if (enabled || !meta.reset)
                return;

            const snap = this._client.snapshot;
            if (!snap.canControl || snap.loggedOut ||
                snap.backendState === 'NeedsLogin' ||
                snap.backendState === 'NoState') {
                // Say so rather than fail quietly: nothing reconciles this
                // later by design, so the user has to know the daemon side did
                // not happen and that re-clicking is what fixes it.
                Notifier.notify({
                    category: Category.ERRORS,
                    level: 'warning',
                    message: `${meta.label}: ${_('not applied, daemon unavailable')}`,
                });
                return;
            }
            if (!meta.isSet(snap))
                return;

            Notifier.withFeedback(
                Category.NETWORK,
                `${meta.label}: ${_('turning off')}`,
                `${meta.label}: ${_('off')}`,
                () => meta.reset(this._client),
            );
        };

        this._settings.connectObject(
            ...Object.keys(FEATURE_META).flatMap((key) => [
                `changed::${key}`,
                () => handleFeatureToggled(key),
            ]),
            this,
        );
```

- [ ] **Step 4: Drop the five schema keys**

Delete the `feature-exit-nodes-saved`, `feature-dns-saved`, `feature-routes-saved`, `feature-shields-up-saved` and `feature-ssh-server-saved` blocks (`:108-130`) from the gschema. Leave `feature-taildrop-available` and `feature-funnels-available` in place — they are the ACL cache, not backups.

Run: `rtk make schemas`
Expected: no error.

- [ ] **Step 5: Verify**

```bash
rtk make test-syntax
rtk make test
rg -n 'ensureFeatureCompliance|savedKey|-saved' extension.js lib/ prefs.js schemas/
```

Expected: syntax OK, 37 tests pass, `rg` returns **no match**.

Then confirm every gschema key still has a consumer:

```bash
for k in $(rg -o 'key name="([^"]+)"' -r '$1' schemas/*.xml); do
  rg -q -- "$k" extension.js prefs.js lib/ || echo "orphan: $k";
done
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
rtk git add extension.js schemas/
rtk git commit -m "refactor: reset a feature once at click time, drop drift correction"
```

---

### Task 4: Collapse `QuietScope` and remove `force`

`ext:193` was the only caller of `QuietScope.ALL`. With one scope left the concept has no object — and `force` with it: its role was piercing an `ALL` window, but under a spontaneous-only window a non-spontaneous notification passes by construction. All three of its uses are non-spontaneous.

**Files:**
- Modify: `lib/notify-policy.js:33-46` (`QuietScope` + doc), `:52-57` (constructor), `:69-78` (`beginQuiet`), `:82-98` (`_hasScope`, `quietCount`), `:100-120` (`shouldShow`)
- Modify: `lib/notify.js:13,17` (import/export), `:102-121` (`notify`), `:123-135` (`beginQuiet`), `:180-236` (`withFeedback`)
- Modify: `extension.js:15` (import), `openQuietWindow` (added in Task 2)
- Test: `tests/notify-policy.test.js:2` (import), `:62-109` (quiet-window cases)

**Interfaces:**
- Consumes: `NotifyPolicy` from Task 2's untouched policy layer.
- Produces: `beginQuiet()` taking no argument and returning a token; `shouldShow({ category, level, spontaneous })` with no `force`; `Notifier.notify({ category, message, level, gicon, spontaneous })` with no `force`.

- [ ] **Step 1: Rewrite the failing tests**

In `tests/notify-policy.test.js`, drop `QuietScope` from the import (`:2`):

```js
import { Category, CATEGORY_KEY, NotifyPolicy } from '../lib/notify-policy.js';
```

Replace the five cases at `:62-109` with:

```js
    test('a quiet window mutes only spontaneous notifications', () => {
        const p = new NotifyPolicy();
        p.beginQuiet();
        assertFalse(show(p, { spontaneous: true }), 'spontaneous is muted');
        assertTrue(show(p, { spontaneous: false }), 'user action still passes');
    });

    // What `force` used to guarantee, now carried by spontaneous: false — and
    // it still stops at the category filter, which is the whole point of an
    // off switch that means it.
    test('a quiet window never overrides the category filter', () => {
        const p = new NotifyPolicy();
        p.beginQuiet();
        p.setCategoryEnabled(Category.TAILDROP, false);
        assertFalse(show(p, { spontaneous: false }), 'a muted category stays muted');
    });

    test('quiet windows nest and release by token', () => {
        const p = new NotifyPolicy();
        const a = p.beginQuiet();
        const b = p.beginQuiet();
        assertEq(p.quietCount, 2, 'two windows open');
        p.endQuiet(a);
        assertFalse(show(p, { spontaneous: true }), 'still muted while the second window is open');
        p.endQuiet(b);
        assertTrue(show(p, { spontaneous: true }), 'released once the last window closes');
        assertEq(p.quietCount, 0, 'stack drained');
    });

    test('endQuiet on an unknown token is harmless', () => {
        const p = new NotifyPolicy();
        p.endQuiet(9999);
        assertEq(p.quietCount, 0, 'no spurious entry');
    });

    test('clearQuiet drains the stack', () => {
        const p = new NotifyPolicy();
        p.beginQuiet();
        p.beginQuiet();
        p.clearQuiet();
        assertEq(p.quietCount, 0, 'drained');
        assertTrue(show(p, { spontaneous: true }), 'nothing muted after a clear');
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `rtk make test`
Expected: FAIL — `beginQuiet()` with no argument stores `undefined` as a scope, so `_hasScope(SPONTANEOUS)` never matches and the muting assertions fail.

- [ ] **Step 3: Simplify `lib/notify-policy.js`**

Delete the `QuietScope` export and its doc block (`:33-46`), and move the surviving rationale onto `beginQuiet`. The stack becomes a plain set of tokens:

```js
export class NotifyPolicy {
    constructor() {
        this._enabled = new Map();
        this._quiet = new Set();   // open window tokens
        this._nextToken = 1;
    }
```

```js
    /**
     * Open a quiet window.
     *
     * A window silences only what nobody asked for — watcher events and daemon
     * signals, marked `spontaneous` — so two user actions in quick succession
     * still both report. Callers must pair this with endQuiet().
     *
     * @returns {number} token to pass back to endQuiet()
     */
    beginQuiet() {
        const token = this._nextToken++;
        this._quiet.add(token);
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
```

Delete `_hasScope` entirely, and reduce `shouldShow`:

```js
    /**
     * @param {{category: string, level: string, spontaneous?: boolean}} opts
     * @returns {boolean}
     */
    shouldShow({ category, level, spontaneous = false }) {
        if (spontaneous && this._quiet.size)
            return false;
        if (this.isCategoryEnabled(category))
            return true;
        // Safety net: a muted domain must not hide its own failures.
        return ALERT_LEVELS.includes(level) &&
            this.isCategoryEnabled(Category.ERRORS);
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `rtk make test`
Expected: PASS — 36 tests.

- [ ] **Step 5: Propagate through `lib/notify.js`**

Import and re-export without `QuietScope` (`:13`, `:17`):

```js
import { Category, CATEGORY_KEY, NotifyPolicy } from './notify-policy.js';
```
```js
export { Category };
```

Drop `force` from `notify()` (`:102-121`) — the JSDoc line, the destructuring default and the `shouldShow` call:

```js
    /**
     * @param {{category: string, message: string, level?: string,
     *          gicon?: Gio.Icon, spontaneous?: boolean}} opts
```
```js
    notify({ category, message, level = 'info', gicon = null,
             spontaneous = false }) {
```
```js
        if (!this._policy.shouldShow({ category, level, spontaneous }))
```

Drop the argument from the wrapper (`:123-131`):

```js
    /**
     * Open a quiet window. Callers must pair this with endQuiet().
     *
     * @returns {number} token
     */
    beginQuiet() {
        return this._policy?.beginQuiet() ?? 0;
    },
```

In `withFeedback`, `beginQuiet()` loses its argument (`:189`) and both `notify()` calls lose `force: true` with the comments that justified it (`:190-198`, `:226-233`):

```js
            const quiet = this.beginQuiet();
            // A user-initiated operation is not spontaneous, so it crosses its
            // own window — and any other open one — untouched. That is what
            // keeps the second of two quick actions from being swallowed.
            let handle = this.notify({
                category, level: 'pending', message: pendingMsg,
            });
```
```js
            // The pending state may have been filtered while the result is not:
            // muting a category still lets its failures through (notify-errors).
            // Create the notification late in that case rather than swallowing a
            // failure the user asked to see.
            if (handle.isNoop)
                handle = this.notify({ category, level, message });
```

- [ ] **Step 6: Propagate through `extension.js`**

Drop `QuietScope` from the import (`:15`):

```js
import { Notifier, Category } from './lib/notify.js';
```

And from `openQuietWindow`:

```js
            this._quietToken = Notifier.beginQuiet();
```

- [ ] **Step 7: Verify**

```bash
rtk make test-syntax
rtk make test
rg -n 'QuietScope|\bforce\b' extension.js lib/ tests/ prefs.js
```

Expected: syntax OK, 36 tests pass, `rg` returns **no match**. Read the output rather than assuming: `force` is a common word, and a hit inside prose is a hit to look at, not to ignore.

- [ ] **Step 8: Commit**

```bash
rtk git add lib/notify-policy.js lib/notify.js extension.js tests/notify-policy.test.js
rtk git commit -m "refactor(notify): one kind of quiet window, no force flag"
```

---

### Task 5: Documentation and the final sweep

**Files:**
- Modify: `README.md:25-26` (feature bullet), `:143-155` (source tree)
- Modify: `CHANGELOG.md` (Unreleased section)

**Interfaces:**
- Consumes: the finished state of Tasks 1–4.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Correct the README**

The account-switcher bullet (`:25-26`) claims a behaviour that is now the daemon's:

```markdown
- **Account switcher** that always reconnects after a switch. Per-profile
  settings — exit node, Magic DNS, accepted routes — are restored by
  tailscaled itself, so the extension keeps no copy of them.
```

The source tree (`:143-155`) still lists `per-account.js` and predates the notification rewrite. Replace the `lib/` block with:

```
lib/
├── tailscale.js        # CLI wrapper + poller
├── indicator.js        # panel icon
├── menu.js             # Quick Settings toggle + submenus
├── watchers.js         # snapshot diffing into semantic events
├── notify-policy.js    # category, level and quiet-window rules
├── notify.js           # notification entry point, picks a backend
├── tray.js             # persistent backend (MessageTray.Source)
├── toast.js            # OSD-style transient backend
└── util.js             # helpers shared by shell and prefs processes
```

- [ ] **Step 2: Record the behaviour changes in the CHANGELOG**

Under `## Unreleased`, extend `### Changed` and add `### Removed`:

```markdown
### Changed
- Toast duration and minimum pending duration moved from the General page to
  the new Notifications page.
- Keyboard shortcuts moved from the General page to their own page.
- Feature toggles are now global rather than per-tailnet. Switching a feature
  off still switches the matching tailscale setting off, once, at that moment;
  switching it back on no longer restores a remembered value — the menu shows
  whatever the daemon has. Existing per-tailnet toggles collapse to the values
  of whichever account was active at upgrade time.

### Removed
- Per-tailnet feature-state persistence. tailscaled already stores exit node,
  Magic DNS, accepted routes, shields, SSH and LAN access per profile and
  restores them on `tailscale switch`; the extension's copy duplicated that and
  could overwrite what the daemon had just restored.
```

- [ ] **Step 3: Run the full sweep**

Every export confronted with the tree's imports:

```bash
for s in $(rg -o 'export (?:const|function|class) (\w+)' -r '$1' lib/); do
  rg -q "\b$s\b" extension.js prefs.js lib/ tests/ --glob '!lib/*' || echo "unused export: $s";
done
rg -n 'stylesheet|style_class' lib/ extension.js | rg -o "style_class: *'([^']+)'" -r '$1' | sort -u
```

Cross-check that last list against the classes in `stylesheet.css`; report any class defined but never applied, and any applied but never defined. Report findings — do not delete CSS in this task.

- [ ] **Step 4: Verify the packaged extension**

```bash
rtk make test
rtk make test-syntax
rtk make pack && shexli tailscale-gnome@diskmth.fr.shell-extension.zip
```

Expected: 36 tests pass, syntax OK on every file, and shexli reports **0 errors, 0 warnings** with a single `manual_review` for clipboard access.

- [ ] **Step 5: Commit**

```bash
rtk git add README.md CHANGELOG.md
rtk git commit -m "docs: per-account state is gone, tailscaled owns per-profile prefs"
```

---

## Manual verification (after Task 5, in a nested session)

`dbus-run-session -- gnome-shell --devkit`. These cannot be automated: an extension does not run outside a Shell session.

| # | Scenario | Expected |
|---|---|---|
| 1 | switch personal ↔ work | each profile's exit node, Magic DNS and routes come back on their own; the extension writes nothing |
| 2 | same | exactly **one** "Profile applied" notification |
| 3 | switch from the menu | one notification, the withFeedback's — no duplicate |
| 4 | `tailscale switch` from a terminal | the notification still fires |
| 5 | turn `notify-profile-switch` off, switch | silence on the switch |
| 6 | click Magic DNS during a switch | the action reports — this is the deliberate change from the ALL window |
| 7 | uncheck Magic DNS | `CorpDNS` goes false, one notification |
| 8 | re-check Magic DNS | the submenu returns showing `off`, nothing is restored |
| 9 | uncheck Exit nodes while auto mode is active | routing is actually cleared |
| 10 | uncheck Funnel with a funnel running | the funnel is torn down |
| 11 | stop `tailscaled`, uncheck a feature | "not applied, daemon unavailable" warning, UI hides, nothing fires when the daemon returns |
| 12 | switch with a slow daemon | the hard ceiling closes the window, notifications resume |
| 13 | disable the extension mid-switch | no leftover timeouts or sources |

Item 13 is the one not to rush: it is the class of defect behind both EGO rejections.
