// Tailscale GNOME entry point.
// GNOME Shell 46+ (ESM extensions API).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { TailscaleClient } from './lib/tailscale.js';
import { TailscaleIndicator } from './lib/indicator.js';
import { openAdminPanel, statusText } from './lib/menu.js';
import { Notifier, Category, QuietScope } from './lib/notify.js';
import { SnapshotWatcher } from './lib/watchers.js';
import { fmt as _fmt } from './lib/util.js';

// Keys backed by `as` arrays in the GSettings schema. Each key holds zero or
// one accelerators (e.g. ["<Super>t"]). Empty array = unbound.
const SHORTCUT_KEYS = [
    'shortcut-toggle-tailscale',
    'shortcut-toggle-exit-node',
    'shortcut-show-menu',
    'shortcut-open-admin-panel',
    'shortcut-send-file',
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
            binary:      this._settings.get_string('tailscale-binary') || 'tailscale',
            pollSeconds: this._settings.get_int('poll-interval'),
            settings:    this._settings,
        });

        this._settings.connectObject(
            'changed::poll-interval', () => {
                this._client.setPollSeconds(this._settings.get_int('poll-interval'));
            },
            'changed::tailscale-binary', () => {
                this._client.setBinary(
                    this._settings.get_string('tailscale-binary') || 'tailscale',
                );
            },
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

        // Snapshot-derived notifications. The watcher is a pure diff; this
        // table is where its events become user-facing copy, which is why
        // watchers.js carries no gettext import.
        const WATCHER_COPY = {
            'connection-starting':   () => _('Connecting Tailscale — this may take a moment'),
            'connection-established': () => _('Tailscale connected'),
            // A Starting phase that resolved to anything other than Running:
            // reuse the pill's status vocabulary (Login required / Logged
            // out / Tailscale unavailable / …) off the live snapshot, rather
            // than a single generic string that ignores why it ended.
            'connection-ended':      () => statusText(this._client.snapshot),
            'exit-node-lost':        () => _('Auto exit node lost'),
            'exit-node-acquired':    (d) => _fmt(_('Auto exit node: %s'), d.name),
            'exit-node-switched':    (d) => _fmt(_('Auto exit node switched to %s'), d.name),
            'exit-node-offline':     (d) => _fmt(_('Exit node %s went offline'), d.name),
            'exit-node-online':      (d) => _fmt(_('Exit node %s is back online'), d.name),
            'exit-node-disabled':    (d) => _fmt(_('Exit node %s was disabled'), d.name),
            'exit-node-reenabled':   (d) => _fmt(_('Exit node %s was re-enabled'), d.name),
            'account-switched':      (d) => _fmt(_('Profile applied (%s)'), d.name),
        };

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

        this._watcher = new SnapshotWatcher();
        // A pending connection resolves in place, so its handle outlives the
        // event that created it.
        this._connHandle = null;
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

        this._client.start();

        // Every snapshot during the window pushes the close back, so the
        // window lasts as long as the daemon keeps changing its mind.
        this._client.connectObject(
            'state-changed', () => armQuietDebounce(),
            this,
        );

        // One-shot Taildrop/Funnel availability probe at startup, then
        // again whenever the active tailnet changes — admin ACLs differ
        // per tailnet, so the cached availability flags can't be assumed
        // to carry over. Delayed slightly so the initial daemon refresh
        // has time to settle (probeAvailability runs a CLI subprocess
        // that races with the first poll otherwise).
        this._availabilityProbeId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 1, () => {
                this._availabilityProbeId = 0;
                this._client.probeAvailability().catch(() => {});
                return GLib.SOURCE_REMOVE;
            });

        // Restore Taildrop receiver state. The setting is the source of
        // truth across reloads; the receiver subprocess is owned by the
        // client and gets killed on `disable()` via client.destroy().
        // The receiver only runs when BOTH the user-facing accept toggle
        // is on AND the Taildrop feature itself is enabled in prefs.
        const syncTaildrop = () => {
            const featureOn = this._settings.get_boolean('feature-taildrop');
            const acceptOn  = this._settings.get_boolean('taildrop-accept');
            const inbox     = this._settings.get_string('taildrop-inbox');
            this._client.setAcceptFiles(featureOn && acceptOn, inbox);
        };
        syncTaildrop();
        this._settings.connectObject(
            'changed::taildrop-accept',  syncTaildrop,
            'changed::feature-taildrop', syncTaildrop,
            'changed::taildrop-inbox', () => {
                // Inbox path changed: bounce the receiver if it's running so
                // the new directory takes effect.
                const featureOn = this._settings.get_boolean('feature-taildrop');
                const acceptOn  = this._settings.get_boolean('taildrop-accept');
                if (featureOn && acceptOn) {
                    this._client.setAcceptFiles(false);
                    this._client.setAcceptFiles(true,
                        this._settings.get_string('taildrop-inbox'));
                }
            },
            this,
        );

        // One-shot startup check: if the operator pref is missing once the
        // first poll has landed, fire a single polkit prompt. We avoid a
        // state-changed handler because login transiently flips
        // canControl=false while the pkexec child runs, and a listener
        // would race it with its own prompt. Skipped while logged out:
        // login restores the operator by itself (--operator flag), so
        // prompting before a login would just double the elevations.
        // After startup, the user's own actions (clicking the toggle, the
        // menu "Set operator" button, etc.) handle every re-prompt
        // explicitly.
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

        this._exportDbus();
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

    disable() {
        this._unexportDbus();

        this._settings.disconnectObject(this);
        this._client.disconnectObject(this);

        if (this._startupCheckId) {
            GLib.source_remove(this._startupCheckId);
            this._startupCheckId = 0;
        }

        if (this._availabilityProbeId) {
            GLib.source_remove(this._availabilityProbeId);
            this._availabilityProbeId = 0;
        }

        for (const key of this._boundShortcuts)
            Main.wm.removeKeybinding(key);
        this._boundShortcuts.clear();

        this._indicator.destroy();
        this._indicator = null;

        this._client.destroy();
        this._client = null;

        this._connHandle = null;
        this._watcher = null;

        if (this._quietDebounceId) {
            GLib.source_remove(this._quietDebounceId);
            this._quietDebounceId = 0;
        }
        if (this._quietCeilingId) {
            GLib.source_remove(this._quietCeilingId);
            this._quietCeilingId = 0;
        }
        this._quietToken = 0;

        Notifier.destroy();

        this._settings = null;
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

    _shortcutHandler(key) {
        switch (key) {
        case 'shortcut-toggle-tailscale':
            return () => {
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
            return () => openAdminPanel();
        case 'shortcut-send-file':
            return () => this._indicator.sendFiles();
        default:
            return null;
        }
    }
}
