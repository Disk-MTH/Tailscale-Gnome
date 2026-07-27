# Feature Toggles Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the seven `feature-*` display toggles, so the extension never writes daemon state on its own, and turn the Taildrop/Funnel admin-availability detection from a switch into a status icon.

**Architecture:** The toggles go from all four places that read them — the reset handler in `extension.js`, the menu's visibility gates, the prefs panel, and the schema. What survives is the availability cache for Taildrop and Funnel, which is a fact about the tailnet rather than a user choice: it keeps its probe, its manual check button and its admin link, and gains a ✓/✗ icon where the switch was. The Taildrop receiver, which the toggle used to gate, is gated on availability instead.

**Tech Stack:** GJS (GNOME Shell 45+ ESM), GTK4/libadwaita for prefs, GSettings/gschema XML, a dependency-free test harness under `tests/` run by `make test`.

**Spec:** `docs/superpowers/specs/2026-07-27-feature-toggles-removal-design.md`

## Global Constraints

- All shipped artefacts — code, comments, translatable strings, README, CHANGELOG — are **in English**. Only the spec and plan documents are French.
- `make test` (37 tests) and `make test-syntax` must pass at the end of every task. **No test is added by this plan**: nothing that changes here is a pure rule — `menu.js`, `prefs.js` and the wiring in `extension.js` all need a GNOME session. Verification is the syntax check, the greps each task specifies, and the manual pass at the end.
- Timeout sources and signal handlers: store the id, clear before re-arming, disconnect on destroy. Leaked sources are the class of defect behind both EGO rejections.
- `prefs.js` runs in a **separate process** from `extension.js` and has no `TailscaleClient`. It probes by spawning the CLI through the shared helpers in `lib/util.js`.
- Final reference not to degrade: `make pack && shexli tailscale-gnome@diskmth.fr.shell-extension.zip` → **0 errors, 0 warnings**, one `manual_review` (clipboard access, already declared in `metadata.json`).
- Keys `feature-taildrop-available` and `feature-funnels-available` keep their names. Renaming them is explicitly out of scope (spec §7).
- Commit after every task, conventional-commit prefixes.

---

### Task 1: Delete the reset handler, gate the receiver on availability

`extension.js` is where the toggles had teeth: a `changed::` on any of the seven ran a notification and, for six of them, a daemon write. Removing this block is what makes the extension stop writing daemon state unbidden.

**Files:**
- Modify: `extension.js:220-247` (`syncTaildrop`), `:270-369` (the whole `feature reset on toggle-off` block)

**Interfaces:**
- Consumes: `this._settings`, `this._client.setAcceptFiles(enabled, inbox)` — both unchanged.
- Produces: nothing new. After this task `extension.js` reads exactly one `feature-*` key, `feature-taildrop-available`, and calls no client setter outside `setAcceptFiles`.

- [ ] **Step 1: Gate the Taildrop receiver on availability**

Replace `syncTaildrop` and its subscriptions (`:220-247`) with:

```js
        // Restore Taildrop receiver state. The setting is the source of
        // truth across reloads; the receiver subprocess is owned by the
        // client and gets killed on `disable()` via client.destroy().
        // The receiver only runs when the user-facing accept toggle is on
        // AND the tailnet actually allows Taildrop — a receiver on a tailnet
        // that forbids it would never receive anything.
        const syncTaildrop = () => {
            const availableOn = this._settings.get_boolean('feature-taildrop-available');
            const acceptOn    = this._settings.get_boolean('taildrop-accept');
            const inbox       = this._settings.get_string('taildrop-inbox');
            this._client.setAcceptFiles(availableOn && acceptOn, inbox);
        };
        syncTaildrop();
        this._settings.connectObject(
            'changed::taildrop-accept', syncTaildrop,
            'changed::feature-taildrop-available', syncTaildrop,
            'changed::taildrop-inbox', () => {
                // Inbox path changed: bounce the receiver if it's running so
                // the new directory takes effect.
                const availableOn = this._settings.get_boolean('feature-taildrop-available');
                const acceptOn    = this._settings.get_boolean('taildrop-accept');
                if (availableOn && acceptOn) {
                    this._client.setAcceptFiles(false);
                    this._client.setAcceptFiles(true,
                        this._settings.get_string('taildrop-inbox'));
                }
            },
            this,
        );
```

- [ ] **Step 2: Delete the reset block**

Remove everything from the `/* -------------------- feature reset on toggle-off -------------------- */` banner (`:270`) through the closing `);` of the `this._settings.connectObject(...)` that subscribes `handleFeatureToggled` (`:369`) — the banner, both comment blocks, `FEATURE_META`, `handleFeatureToggled` and the subscription. `this._exportDbus();` on the next line stays.

- [ ] **Step 3: Prune now-unused imports**

`Category` and `Notifier` are still used elsewhere in the file (the watcher event loop notifies through them), so both imports stay. Confirm rather than assume:

```bash
rg -n 'Category\.|Notifier\.' extension.js | head -20
```

If either name has no remaining use, remove it from the import at the top of the file. Report what you found.

- [ ] **Step 4: Verify**

```bash
rtk make test-syntax
rtk make test
rg -n 'FEATURE_META|handleFeatureToggled' extension.js
rg -n "feature-(exit-nodes|dns|routes|shields-up|ssh-server|taildrop|funnels)'" extension.js
```

Expected: syntax OK, 37 tests pass, the first `rg` returns no match, and the second returns **only** hits ending in `-available` (the pattern deliberately excludes them by requiring the closing quote right after the key name).

- [ ] **Step 5: Commit**

```bash
rtk git add extension.js
rtk git commit -m "refactor: drop the feature reset handler, gate Taildrop on availability"
```

---

### Task 2: Menu shows everything the tailnet allows

**Files:**
- Modify: `lib/menu.js:590-607` (`renderKeys` and its comment), `:1562-1588` (`_applyFeatureGates` and its comment)

**Interfaces:**
- Consumes: `feature-taildrop-available` and `feature-funnels-available` from GSettings.
- Produces: nothing new.

- [ ] **Step 1: Shrink the re-render key list**

Replace the comment and array at `:590-607` with:

```js
            // Re-render when the Taildrop accept toggle is changed elsewhere
            // (prefs dialog, dconf-editor), or when the per-tailnet
            // availability cache moves — so blocks the tailnet has just been
            // granted appear, and admin-disabled ones disappear, without
            // waiting for the next poll.
            const renderKeys = [
                'taildrop-accept',
                'feature-taildrop-available',
                'feature-funnels-available',
            ];
```

The `this._settings.connectObject(...renderKeys.flatMap(...))` below it is unchanged.

- [ ] **Step 2: Reduce the gates to what the tailnet allows**

Replace `_applyFeatureGates` and its comment (`:1562-1588`) with:

```js
        // Honor the per-tailnet availability cache. Called after the main
        // render pass has marked all items visible; this trims down to what
        // the admin has allowed. The Send/Funnel separator hides when both
        // halves of its block are off so we don't get an orphan divider.
        //
        // Nothing else is gated: exit nodes, Magic DNS, routes, shields and
        // SSH are always shown, because whether they are useful is the
        // daemon's business, not a setting.
        _applyFeatureGates() {
            const s = this._settings;
            // ACL-gated features: hide them when the daemon told us the
            // tailnet doesn't allow them, so the user can't try to wire up a
            // funnel that the control plane would refuse.
            const taildrop = s.get_boolean('feature-taildrop-available');
            const funnels  = s.get_boolean('feature-funnels-available');
            this._acceptFilesRow.visible  &&= taildrop;
            this._sendFileRow.visible     &&= taildrop;
            this._funnelSubMenu.visible   &&= funnels;
            this._funnelSeparator.visible &&= (taildrop || funnels);
        }
```

- [ ] **Step 3: Verify**

```bash
rtk make test-syntax
rtk make test
rg -n "feature-(exit-nodes|dns|routes|shields-up|ssh-server|taildrop|funnels)'" lib/menu.js
```

Expected: syntax OK, 37 tests pass, `rg` returns **no match** (only the two `-available` keys survive, and the pattern excludes them).

- [ ] **Step 4: Commit**

```bash
rtk git add lib/menu.js
rtk git commit -m "refactor(menu): gate only on what the tailnet allows"
```

---

### Task 3: The Features panel becomes an availability panel

A switch invites action. The user can do nothing about an ACL, so the row stops offering a control it cannot honour and shows a state instead — while keeping everything that helps: the explanation, the doc link, the admin link, the manual re-check.

**Files:**
- Modify: `prefs.js:175-200` (Taildrop group sensitivity), `:527-563` (`FEATURE_DEFS`), `:600-717` (`_makeFeatureRow`, `_makeFeaturesGroup`), and `fillPreferencesWindow` (the `_makeFeaturesGroup` call site plus a new background probe)

**Interfaces:**
- Consumes: `_checkTaildrop(bin)` / `_checkFunnel(bin)` — both `async (bin: string) => boolean`, already defined in this file; `_openUrl(url)`; `_resetButton(settings, key)` (still used by other groups, do not delete it).
- Produces: `AVAILABILITY_DEFS`, the renamed and reduced two-entry table; `_makeAvailabilityRow(settings, def, window)`; `_makeAvailabilityGroup(settings, window)`.

- [ ] **Step 1: Reduce and rename the definition table**

Replace the comment and `FEATURE_DEFS` (`:527-563`) with the same two entries, minus the five network ones, minus each entry's now-unused `key` field:

```js
// Taildrop and Funnel can be forbidden tailnet-wide by an administrator.
// That is a fact to report, not a setting: each row shows the cached probe
// result, offers a re-check, and points at the admin page when the answer
// is no.
const AVAILABILITY_DEFS = [
    {
        availabilityKey: 'feature-taildrop-available',
        title: () => _('Taildrop'),
        adminUrl: 'https://login.tailscale.com/admin/settings/general',
        docUrl: 'https://tailscale.com/docs/features/taildrop',
        unavailableHint: () => _('Taildrop is disabled for this tailnet.'),
        infoText: () =>
            _(
                'Taildrop requires the feature to be enabled for the tailnet and the source and destination devices to be owned by the same user. Devices owned by a tag or by different users are not eligible.',
            ),
        checker: _checkTaildrop,
    },
    {
        availabilityKey: 'feature-funnels-available',
        title: () => _('Funnel'),
        adminUrl:
            'https://login.tailscale.com/admin/acls/visual/node-attributes',
        docUrl: 'https://tailscale.com/docs/features/tailscale-funnel',
        unavailableHint: () => _('Funnel is not enabled for this tailnet.'),
        infoText: () =>
            _(
                'Funnel requires HTTPS certificates to be enabled tailnet-wide and the "funnel" node attribute granted to the current user.',
            ),
        checker: _checkFunnel,
    },
];
```

- [ ] **Step 2: Rewrite the row builder**

Replace `_makeFeatureRow` and `_makeFeaturesGroup` (`:600-717`) with:

```js
// Build one availability row: an explanation, a status icon, a re-check
// button, and — only when the answer is no — a link to the admin page that
// can change it. No switch: the user cannot grant themselves an ACL, and a
// control that cannot honour a click is a lie.
function _makeAvailabilityRow(settings, def, window) {
    const row = new Adw.ActionRow({ title: def.title() });

    const infoBtn = new Gtk.Button({
        icon_name: 'info-outline-symbolic',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat', 'circular'],
        tooltip_text: _fmt(_('%s\n\nClick to open: %s'), def.infoText(), def.docUrl),
    });
    infoBtn.connect('clicked', () => _openUrl(def.docUrl));
    row.add_prefix(infoBtn);

    // libadwaita's success/error classes follow the user's light or dark
    // theme; a hardcoded colour would not.
    const statusIcon = new Gtk.Image({ valign: Gtk.Align.CENTER });

    const checkBtn = new Gtk.Button({
        icon_name: 'rotation-allowed-symbolic',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
        tooltip_text: _('Check availability'),
    });
    checkBtn.connect('clicked', async () => {
        checkBtn.sensitive = false;
        const bin = settings.get_string('tailscale-binary') || 'tailscale';
        let available;
        try {
            available = await def.checker(bin);
        } catch {
            available = false;
        }
        settings.set_boolean(def.availabilityKey, available);
        checkBtn.sensitive = true;
        const title = def.title();
        window.add_toast(
            new Adw.Toast({
                title: available
                    ? _fmt(_('%s is available'), title)
                    : _fmt(_('%s is not available on this tailnet'), title),
                timeout: 3,
            }),
        );
    });

    const adminBtn = new Gtk.Button({
        label: _('Open admin'),
        valign: Gtk.Align.CENTER,
        css_classes: ['suggested-action'],
    });
    adminBtn.connect('clicked', () => _openUrl(def.adminUrl));

    row.add_suffix(statusIcon);
    row.add_suffix(checkBtn);
    row.add_suffix(adminBtn);

    const sync = () => {
        const available = settings.get_boolean(def.availabilityKey);
        statusIcon.icon_name = available
            ? 'emblem-ok-symbolic'
            : 'window-close-symbolic';
        statusIcon.css_classes = [available ? 'success' : 'error'];
        // An icon alone is not readable by a screen reader.
        statusIcon.tooltip_text = available
            ? _('Available on this tailnet')
            : _('Not available on this tailnet');
        row.subtitle = available ? '' : def.unavailableHint();
        adminBtn.visible = !available;
    };
    const id = settings.connect(`changed::${def.availabilityKey}`, sync);
    row.connect('destroy', () => settings.disconnect(id));
    sync();
    return row;
}

function _makeAvailabilityGroup(settings, window) {
    const group = new Adw.PreferencesGroup({
        title: _('Availability'),
        description: _(
            "What this tailnet allows. Both depend on your tailnet's admin settings, not on anything you can change here.",
        ),
    });
    for (const def of AVAILABILITY_DEFS)
        group.add(_makeAvailabilityRow(settings, def, window));
    return group;
}
```

Note the `infoText` and `docUrl` guards are gone: both surviving entries have both fields, so the conditionals had one possible branch. `_resetButton` is still used by other groups — do not delete it.

- [ ] **Step 3: Probe on open**

In `fillPreferencesWindow`, replace the `page.add(_makeFeaturesGroup(settings, window));` call with the new name, and add the background probe just after it:

```js
        /* --------------------------- Availability ------------------------ */
        page.add(_makeAvailabilityGroup(settings, window));

        // Refresh the cache in the background so the status icons are current
        // without the user having to click Check. The window opens immediately
        // on the last known value and each row updates through the `changed::`
        // it is already watching. Failures are silent, exactly as for the
        // startup probe in extension.js: the last known value stays on screen.
        const probeBin = settings.get_string('tailscale-binary') || 'tailscale';
        for (const def of AVAILABILITY_DEFS) {
            def.checker(probeBin)
                .then((ok) => settings.set_boolean(def.availabilityKey, ok))
                .catch(() => {});
        }
```

- [ ] **Step 4: Untie the Taildrop group from the deleted toggle**

Replace the sensitivity block at `:180-200` with a version watching one key:

```js
    // Grey these rows out when the tailnet forbids Taildrop: they would have
    // no effect, and the Availability group above says why.
    const syncSensitivity = () => {
        group.sensitive = settings.get_boolean('feature-taildrop-available');
    };
    const sensId = settings.connect(
        'changed::feature-taildrop-available',
        syncSensitivity,
    );
    group.connect('destroy', () => settings.disconnect(sensId));
    syncSensitivity();
```

- [ ] **Step 5: Verify**

```bash
rtk make test-syntax
rtk make test
rg -n "feature-(exit-nodes|dns|routes|shields-up|ssh-server|taildrop|funnels)'" prefs.js
rg -n 'FEATURE_DEFS|_makeFeatureRow|_makeFeaturesGroup' prefs.js
rg -n '_resetButton' prefs.js | head
```

Expected: syntax OK, 37 tests pass, the first two `rg` calls return **no match**, and the third still shows `_resetButton` defined and used by other groups.

Then confirm the prefs dialog actually builds — a GTK error here is a runtime crash the syntax check cannot see:

```bash
gnome-extensions prefs tailscale-gnome@diskmth.fr
```

If the extension is not installed from this working tree, run `rtk make install` first, and say in your report which you did. If the dialog cannot be opened in this environment at all, say so plainly rather than claiming it works.

- [ ] **Step 6: Commit**

```bash
rtk git add prefs.js
rtk git commit -m "feat(prefs): show Taildrop and Funnel availability instead of toggling it"
```

---

### Task 4: Schema, docs and the sweep

The seven keys are dropped last, once nothing reads them.

**Files:**
- Modify: `schemas/org.gnome.shell.extensions.tailscale-gnome.gschema.xml:73-106`
- Modify: `README.md` (features bullet, settings table, and any other stale mention)
- Modify: `CHANGELOG.md` (Unreleased)

**Interfaces:**
- Consumes: the finished state of Tasks 1–3.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Drop the seven keys**

Delete the `feature-exit-nodes`, `feature-dns`, `feature-routes`, `feature-shields-up`, `feature-ssh-server`, `feature-taildrop` and `feature-funnels` key blocks (`:73-106`). Keep `feature-taildrop-available` and `feature-funnels-available` untouched.

Run: `rtk make schemas`
Expected: no error.

- [ ] **Step 2: Prove no key is orphaned and no reader is dangling**

Both directions matter: a key nothing reads is dead weight, and a key read but absent from the schema aborts the process on access.

```bash
for k in $(rg -o 'key name="([^"]+)"' -r '$1' schemas/*.xml); do
  rg -q -- "$k" extension.js prefs.js lib/ || echo "orphan key: $k";
done
for k in $(rg -oN "'(feature-[a-z-]+)'" -r '$1' extension.js prefs.js lib/ | sort -u); do
  rg -q "key name=\"$k\"" schemas/*.xml || echo "dangling read: $k";
done
```

Expected: no output from either loop. If a loop misfires in this shell (zsh), fix your invocation and report what you actually ran — the answer matters, not the exact command.

- [ ] **Step 3: Correct the README**

Three sites, all currently wrong:

The features bullet (`README.md:32-33`) says "Prefs toggles", but those controls live in the Quick Settings menu and always have:

```markdown
- **Menu toggles** for Magic DNS, Accept routes, Shields up, SSH
  server, Allow LAN access.
```

The settings table lists three Features rows that no longer exist. Replace these three lines:

```
| General       | Features: exit nodes / DNS / routes / etc. | on    |
| General       | Features: Taildrop                 | off           |
| General       | Features: Funnel                   | off           |
```

with one:

```
| General       | Availability: Taildrop / Funnel    | probed        |
```

Then search the whole file for any other claim about hiding features or per-feature preferences and fix what you find:

```bash
rg -ni 'feature|hidden|hide|toggle' README.md
```

Report every hit and what you did with it.

- [ ] **Step 4: Record the removal in the CHANGELOG**

Under `## Unreleased`, extend the existing `### Removed` section with:

```markdown
- The per-feature visibility toggles. Hiding a block of the menu was a
  setting nobody used, and supporting it was the extension's last reason to
  write daemon state on its own — turning a feature off used to switch the
  matching tailscale setting off with it. Every block the tailnet allows is
  now always shown, and no daemon write happens unless you ask for one.
  Taildrop and Funnel keep their admin-availability detection: the
  preferences show it as a status rather than a switch, since an ACL is not
  something a checkbox can grant.
```

- [ ] **Step 5: Verify the packaged extension**

```bash
rtk make test
rtk make test-syntax
rtk make pack && shexli tailscale-gnome@diskmth.fr.shell-extension.zip
```

Expected: 37 tests pass, syntax OK on every file, shexli reports **0 errors, 0 warnings** with a single `manual_review` for clipboard access.

- [ ] **Step 6: Commit**

```bash
rtk git add schemas/ README.md CHANGELOG.md
rtk git commit -m "docs: the feature toggles are gone, availability is a status"
```

---

## Manual verification (after Task 4, in a nested session)

`dbus-run-session -- gnome-shell --devkit`. None of this can be automated: an extension does not run outside a Shell session.

| # | Scenario | Expected |
|---|---|---|
| 1 | open the menu | exit node, Magic DNS, routes, shields, SSH all present, unconditionally |
| 2 | tailnet allowing Taildrop and Funnel | both blocks present |
| 3 | tailnet refusing Funnel | Funnel block absent, no orphan separator |
| 4 | open preferences | both rows show ✓ or ✗; the probe runs on its own, no click needed |
| 5 | an unavailable row | red cross, explanatory subtitle, **Open admin** visible |
| 6 | an available row | green tick, no **Open admin**, no subtitle |
| 7 | click the check button | the icon updates, a toast confirms |
| 8 | tick "accept files" on a tailnet allowing Taildrop | the receiver starts |
| 9 | switch to an account whose tailnet has different ACLs | the menu blocks follow the new availability |
| 10 | "Reset all" in preferences | both rows re-probe, icons update |
| 11 | disable the extension | no leftover timeouts or sources |
| 12 | light theme, then dark theme | the tick and the cross stay legible in both |

Item 11 is the one not to rush: it is the class of defect behind both EGO rejections.
