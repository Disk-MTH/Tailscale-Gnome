// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// Tailscale GNOME entry point.
// GNOME Shell 46+ (ESM extensions API).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { TailscaleClient, backendStatus } from './lib/tailscale.js';
import { TailscaleIndicator } from './lib/indicator.js';
import { openAdminPanel, requireBackend } from './lib/menu.js';
import { Notifier, Category } from './lib/notify.js';
import { SnapshotWatcher } from './lib/watchers.js';
import { watcherMessage } from './lib/watcher-messages.js';
import { QuietWindow } from './lib/quiet-window.js';
import * as NautilusIntegration from './lib/nautilus.js';

// Keys backed by `as` arrays in the GSettings schema. Each key holds zero or
// one accelerators (e.g. ["<Super>t"]). Empty array = unbound.
const SHORTCUT_KEYS = [
    'shortcut-toggle-tailscale',
    'shortcut-toggle-exit-node',
    'shortcut-show-menu',
    'shortcut-open-admin-panel',
    'shortcut-send-file',
    'shortcut-add-funnel',
];

// Session-bus interface exposed for the Nautilus right-click scripts so they
// can hand off file paths to the in-shell picker instead of running their
// own UI. Kept tiny on purpose: one method, no signals. The object is
// exported on GNOME Shell's own session connection, so clients reach it
// through the org.gnome.Shell bus name — no extra name ownership needed.
const DBUS_PATH = '/org/gnome/Shell/Extensions/TailscaleGnome';
const DBUS_XML = `
<node>
  <interface name="org.gnome.Shell.Extensions.TailscaleGnome">
    <method name="SendFiles">
      <arg type="as" name="paths" direction="in"/>
    </method>
  </interface>
</node>`;

export default class TailscaleGnomeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        Notifier.init(this._settings, { extension: this });

        this._client = new TailscaleClient({
            pollSeconds: this._settings.get_int('poll-interval'),
            settings:    this._settings,
        });
        this._watcher = new SnapshotWatcher();
        this._quiet = new QuietWindow();
        // A pending connection resolves in place, so its handle outlives the
        // event that created it.
        this._connHandle = null;
        // The receiver is a child of the CLI: losing the binary kills it, and
        // the client cannot put it back on its own — nothing down there knows
        // whether the user still wants files. _onState watches this to
        // re-apply the setting the moment the binary returns.
        this._wasInstalled = this._client.snapshot.installed;

        this._settings.connectObject(
            'changed::poll-interval', () =>
                this._client.setPollSeconds(this._settings.get_int('poll-interval')),
            'changed::nautilus-integration', () => this._syncNautilus(),
            'changed::taildrop-accept', () => this._syncTaildrop(),
            'changed::feature-taildrop-available', () => this._syncTaildrop(),
            'changed::taildrop-inbox', () => this._bounceTaildrop(),
            ...SHORTCUT_KEYS.flatMap((key) => [
                `changed::${key}`,
                () => this._rebindShortcut(key),
            ]),
            this,
        );

        this._indicator = new TailscaleIndicator({
            extension: this,
            client:    this._client,
        });
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._boundShortcuts = new Set();
        for (const key of SHORTCUT_KEYS)
            this._rebindShortcut(key);

        this._client.connectObject(
            'state-changed', (_c, snap) => this._onState(snap), this);
        // Seeded rather than left to the first 'state-changed'. On a machine
        // with no Tailscale there is no first one: the client's constructor
        // already probed PATH, so _goMissing() finds nothing to change and
        // stays silent by design. Without this the key would keep whatever
        // the last session that could answer wrote into it.
        this._mirrorState(this._client.snapshot);
        this._client.start();

        // Restore the Taildrop receiver state. The setting is the source of
        // truth across reloads; the receiver subprocess is owned by the
        // client and gets killed on disable() via client.destroy().
        this._syncTaildrop();

        // One-shot startup check: if the operator pref is missing once the
        // first poll has landed, fire a single polkit prompt. We avoid a
        // state-changed handler because login transiently flips
        // canControl=false while the pkexec child runs, and a listener would
        // race it with its own prompt. Skipped while logged out: login
        // restores the operator by itself (--operator flag), so prompting
        // before a login would just double the elevations. After startup,
        // the user's own actions (clicking the toggle, the menu "Set
        // operator" button, etc.) handle every re-prompt explicitly.
        this._startupCheckId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 2, () => {
                this._startupCheckId = 0;
                const snap = this._client.snapshot;
                if (!snap.error && !snap.canControl &&
                    !snap.loggedOut && snap.backendState !== 'NeedsLogin')
                    this._client.setOperator();
                return GLib.SOURCE_REMOVE;
            },
        );

        this._exportDbus();

        // The 0.2.x Scripts-submenu entries go whether the integration is
        // wanted or not: they call the same D-Bus method this file manager
        // extension does, so keeping them would only show the same action
        // twice, three clicks deeper.
        NautilusIntegration.purgeLegacyScripts();
        this._syncNautilus();
    }

    disable() {
        this._unexportDbus();

        // Unlinked unconditionally, setting or no setting: the link resolves
        // into this directory, and an extension uninstalled while disabled
        // would otherwise leave a dangling entry for nautilus-python to trip
        // over on every start.
        NautilusIntegration.uninstall(this.path);

        this._settings.disconnectObject(this);
        this._client.disconnectObject(this);

        if (this._startupCheckId) {
            GLib.source_remove(this._startupCheckId);
            this._startupCheckId = 0;
        }

        for (const key of this._boundShortcuts)
            Main.wm.removeKeybinding(key);
        this._boundShortcuts.clear();

        this._indicator.destroy();
        this._indicator = null;

        this._client.destroy();
        this._client = null;

        this._quiet.close();
        this._quiet = null;
        this._connHandle = null;
        this._watcher = null;

        Notifier.destroy();

        this._settings = null;
    }

    /* ------------------------------ snapshots ---------------------------- */

    // How long the daemon must go quiet after an account switch before the
    // window closes: two poll cycles, so a slow daemon still gets a full one
    // to settle in.
    _settleMs() {
        return this._settings.get_int('poll-interval') * 2000;
    }

    // The three mirrored keys are a mirror of what the last poll saw, not a
    // cache anyone has to refresh: the preferences window runs in its own
    // process and cannot read the snapshot, and the Taildrop receiver is
    // driven off gsettings. Only a real answer is written — an availability
    // we could not read leaves the last one standing.
    _mirrorState(snap) {
        for (const [key, value] of [
            ['feature-taildrop-available', snap.taildropAvailable],
            ['feature-funnels-available', snap.funnelsAvailable],
        ]) {
            if (typeof value !== 'boolean') continue;
            if (this._settings.get_boolean(key) === value) continue;
            this._settings.set_boolean(key, value);
        }

        // No such caution here: backendStatus() answers off fields that are
        // always set, and "we could not tell" is itself one of its answers.
        const status = backendStatus(snap);
        if (this._settings.get_string('backend-status') !== status)
            this._settings.set_string('backend-status', status);
    }

    _onState(snap) {
        this._mirrorState(snap);

        for (const ev of this._watcher.feed(snap)) {
            const message = watcherMessage(ev, snap);
            if (ev.type === 'account-switched') {
                // Unconditional: the daemon churns after a switch whoever
                // started it, and admin ACLs differ per tailnet, so the
                // availability flip that follows is not news either.
                this._quiet.open(this._settleMs());
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
            });
        }

        // Every snapshot during the window pushes the close back, so the
        // window lasts as long as the daemon keeps changing its mind.
        this._quiet.postpone(this._settleMs());

        if (snap.installed && !this._wasInstalled) this._syncTaildrop();
        this._wasInstalled = snap.installed;
    }

    /* ------------------------------- Taildrop ---------------------------- */

    // The receiver only runs when the user-facing accept toggle is on AND the
    // tailnet actually allows Taildrop — a receiver on a tailnet that forbids
    // it would never receive anything.
    _syncTaildrop() {
        const available = this._settings.get_boolean('feature-taildrop-available');
        const accept    = this._settings.get_boolean('taildrop-accept');
        this._client.setAcceptFiles(available && accept,
            this._settings.get_string('taildrop-inbox'));
    }

    // Inbox path changed: bounce a running receiver so the new directory
    // takes effect. Nothing to bounce when it was not running.
    _bounceTaildrop() {
        if (!this._settings.get_boolean('feature-taildrop-available')) return;
        if (!this._settings.get_boolean('taildrop-accept')) return;
        this._client.setAcceptFiles(false);
        this._client.setAcceptFiles(
            true, this._settings.get_string('taildrop-inbox'));
    }

    /* --------------------------- file manager --------------------------- */

    // Not a live toggle, and it cannot be: a file manager reads its
    // extensions directory once, at startup. What this decides is what the
    // next Nautilus to start will find, which is why the preferences say so
    // rather than promising the menu changes under the pointer.
    _syncNautilus() {
        if (this._settings.get_boolean('nautilus-integration'))
            NautilusIntegration.install(this.path);
        else
            NautilusIntegration.uninstall(this.path);
    }

    /* ------------------------------- DBus ------------------------------- */

    _exportDbus() {
        try {
            this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(DBUS_XML, {
                SendFiles: (paths) => {
                    const files = (paths || []).filter((p) => p);
                    if (files.length > 0) this._indicator.sendFiles(files);
                },
            });
            this._dbusImpl.export(Gio.DBus.session, DBUS_PATH);
        } catch (e) {
            // Non-fatal: a stale export (e.g. after a shell crash-restore)
            // just means the Nautilus scripts can't hand off; the shortcut
            // and menu entry still work.
            console.warn(`tailscale-gnome: DBus export failed: ${e.message}`);
        }
    }

    _unexportDbus() {
        if (this._dbusImpl) {
            this._dbusImpl.unexport();
            this._dbusImpl = null;
        }
    }

    /* ----------------------------- shortcuts ---------------------------- */

    _rebindShortcut(key) {
        if (this._boundShortcuts.has(key)) {
            Main.wm.removeKeybinding(key);
            this._boundShortcuts.delete(key);
        }
        const accels = this._settings.get_strv(key);
        if (!accels.length || !accels[0]) return;

        const handler = this._shortcutHandler(key);
        if (!handler) return;

        Main.wm.addKeybinding(
            key,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            handler,
        );
        this._boundShortcuts.add(key);
    }

    // Keybindings reach past the menu, so every one of them that drives a
    // command has to ask requireBackend the question the missing arrow
    // answers by being missing. Sending files and opening Funnels ask it on
    // the other side, in the toggle, because the D-Bus entry point shares
    // those paths.
    _shortcutHandler(key) {
        switch (key) {
        case 'shortcut-toggle-tailscale':
            return () => {
                if (!requireBackend(this._client.snapshot, Category.CONNECTION))
                    return;
                const snap = this._client.snapshot;
                const ready =
                    snap.canControl &&
                    !snap.loggedOut &&
                    snap.backendState !== 'NeedsLogin' &&
                    snap.backendState !== 'NoState';
                if (!ready) {
                    // Same priority as the toggle click: logged out beats
                    // operator-missing, since login restores the operator
                    // by itself.
                    if (snap.loggedOut || snap.backendState === 'NeedsLogin')
                        Notifier.notify({ category: Category.CONNECTION, level: 'info', message: _('Login required') });
                    else if (!snap.canControl)
                        this._client.setOperator();
                    else
                        Notifier.notify({ category: Category.CONNECTION, level: 'info', message: _('Tailscale is not ready yet') });
                    return;
                }
                if (snap.running) {
                    Notifier.withFeedback(
                        Category.CONNECTION,
                        _('Disconnecting Tailscale'),
                        _('Tailscale disconnected'),
                        () => this._client.down(),
                    );
                } else {
                    Notifier.withFeedback(
                        Category.CONNECTION,
                        _('Connecting Tailscale'),
                        _('Tailscale connected'),
                        () => this._client.up(),
                    );
                }
            };
        case 'shortcut-toggle-exit-node':
            return () => {
                if (!requireBackend(this._client.snapshot, Category.CONNECTION))
                    return;
                const snap = this._client.snapshot;
                if (snap.exitNodeID) {
                    Notifier.withFeedback(
                        Category.EXIT_NODE,
                        _('Clearing exit node'),
                        _('Exit node cleared'),
                        () => this._client.setExitNode(''),
                    );
                } else {
                    Notifier.withFeedback(
                        Category.EXIT_NODE,
                        _('Selecting an exit node'),
                        _('Exit node: auto'),
                        () => this._client.setExitNode('auto:any'),
                    );
                }
            };
        case 'shortcut-show-menu':
            return () => this._indicator.openMenu();
        case 'shortcut-open-admin-panel':
            // Gated like the rest even though the URL would open: the menu
            // hides its Admin panel button in this state, and a shortcut
            // that still worked would just be the same button, invisible.
            return () => {
                if (!requireBackend(this._client.snapshot, Category.CONNECTION))
                    return;
                openAdminPanel();
            };
        case 'shortcut-send-file':
            return () => this._indicator.sendFiles();
        case 'shortcut-add-funnel':
            return () => this._indicator.openFunnels();
        default:
            return null;
        }
    }
}
