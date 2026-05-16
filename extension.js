// Tailscale GNOME entry point.
// GNOME Shell 46+ (ESM extensions API).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { TailscaleClient } from './lib/tailscale.js';
import { TailscaleIndicator } from './lib/indicator.js';
import { ToastManager } from './lib/toast.js';

// Keys backed by `as` arrays in the GSettings schema. Each key holds zero or
// one accelerators (e.g. ["<Super>t"]). Empty array = unbound.
const SHORTCUT_KEYS = [
    'shortcut-toggle-tailscale',
    'shortcut-toggle-exit-node',
    'shortcut-show-menu',
    'shortcut-copy-self-ip',
    'shortcut-open-admin-panel',
    'shortcut-send-file',
];

const ADMIN_URL = 'https://login.tailscale.com/admin/machines';

// Session-bus interface exposed for the Nautilus right-click scripts so they
// can hand off file paths to the in-shell picker instead of running their own
// (Zenity-based) UI. Kept tiny on purpose: one method, no signals.
const DBUS_NAME = 'fr.diskmth.TailscaleGnome';
const DBUS_PATH = '/fr/diskmth/TailscaleGnome';
const DBUS_XML = `
<node>
  <interface name="fr.diskmth.TailscaleGnome">
    <method name="SendFiles">
      <arg type="as" name="paths" direction="in"/>
    </method>
  </interface>
</node>`;

export default class TailscaleGnomeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        ToastManager.init(this._settings);

        this._client = new TailscaleClient({
            binary:      this._settings.get_string('tailscale-binary') || 'tailscale',
            pollSeconds: this._settings.get_int('poll-interval'),
            settings:    this._settings,
        });

        this._settingIds = [
            this._settings.connect('changed::poll-interval', () => {
                this._client.setPollSeconds(this._settings.get_int('poll-interval'));
            }),
            this._settings.connect('changed::tailscale-binary', () => {
                this._client.setBinary(
                    this._settings.get_string('tailscale-binary') || 'tailscale',
                );
            }),
        ];

        for (const key of SHORTCUT_KEYS) {
            this._settingIds.push(
                this._settings.connect(`changed::${key}`, () => this._rebindShortcut(key)),
            );
        }

        this._indicator = new TailscaleIndicator({
            extension: this,
            client:    this._client,
        });
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._boundShortcuts = new Set();
        for (const key of SHORTCUT_KEYS)
            this._rebindShortcut(key);

        this._client.start();

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
        this._settingIds.push(
            this._settings.connect('changed::taildrop-accept',  syncTaildrop),
            this._settings.connect('changed::feature-taildrop', syncTaildrop),
            this._settings.connect('changed::taildrop-inbox', () => {
                // Inbox path changed: bounce the receiver if it's running so
                // the new directory takes effect.
                const featureOn = this._settings.get_boolean('feature-taildrop');
                const acceptOn  = this._settings.get_boolean('taildrop-accept');
                if (featureOn && acceptOn) {
                    this._client.setAcceptFiles(false);
                    this._client.setAcceptFiles(true,
                        this._settings.get_string('taildrop-inbox'));
                }
            }),
        );

        // One-shot startup check: if the operator pref is missing once the
        // first poll has landed, fire a single polkit prompt. We avoid a
        // state-changed handler because logout/login transiently flip
        // canControl=false during the privileged script (the daemon clears
        // the pref before the second `set --operator=$USER` lands), and a
        // listener would race the pkexec child with its own prompt. After
        // startup, the user's own actions (clicking the toggle, the menu
        // "Set operator" button, etc.) handle every re-prompt explicitly.
        this._startupCheckId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 2, () => {
                this._startupCheckId = 0;
                const snap = this._client?.snapshot;
                if (snap && !snap.error && !snap.canControl)
                    this._client.setOperator();
                return GLib.SOURCE_REMOVE;
            },
        );

        /* -------------------- feature enforcement -------------------- */
        // A Feature toggled OFF in prefs must also disable the underlying
        // tailscale setting -hiding the menu UI alone leaves the feature
        // active (e.g. accept-routes still letting traffic through). We
        // run a reconciliation pass on every state-changed AND on every
        // feature pref change; both calls are idempotent because each
        // check is gated on "off in prefs but still on in the snapshot".
        const ensureFeatureCompliance = () => {
            const snap = this._client?.snapshot;
            if (!snap || !snap.canControl || snap.loggedOut ||
                snap.backendState === 'NeedsLogin' ||
                snap.backendState === 'NoState')
                return;
            const off = (k) => !this._settings.get_boolean(k);
            if (off('feature-exit-nodes') &&
                (snap.exitNodeID || snap.autoExitNode))
                this._client.setExitNode('');
            if (off('feature-dns') && snap.acceptDNS)
                this._client.setAcceptDNS(false);
            if (off('feature-routes') && snap.acceptRoutes)
                this._client.setAcceptRoutes(false);
            if (off('feature-shields-up') && snap.shieldsUp)
                this._client.setShieldsUp(false);
            if (off('feature-ssh-server') && snap.runSSH)
                this._client.setRunSSH(false);
            if (off('feature-funnels') && (snap.funnels?.length || 0) > 0)
                this._client.resetFunnels();
        };

        this._clientSignalIds = [
            this._client.connect('state-changed', ensureFeatureCompliance),
        ];

        for (const key of [
            'feature-exit-nodes', 'feature-dns', 'feature-routes',
            'feature-shields-up', 'feature-ssh-server', 'feature-funnels',
        ]) {
            this._settingIds.push(
                this._settings.connect(`changed::${key}`,
                    ensureFeatureCompliance),
            );
        }

        this._exportDbus();
    }

    /* ------------------------------- DBus ------------------------------- */

    _exportDbus() {
        try {
            this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(DBUS_XML, {
                SendFiles: (paths) => {
                    const files = (paths || []).filter((p) => p);
                    if (files.length === 0) return;
                    this._indicator?._toggle?._runSendFlow?.(files);
                },
            });
            this._dbusImpl.export(Gio.DBus.session, DBUS_PATH);
            this._dbusOwnerId = Gio.bus_own_name(
                Gio.BusType.SESSION,
                DBUS_NAME,
                Gio.BusNameOwnerFlags.NONE,
                null, null, null,
            );
        } catch (e) {
            // Non-fatal: a name collision (another instance, stale name) just
            // means the Nautilus scripts can't hand off; the shortcut and
            // menu entry still work.
            console.warn(`tailscale-gnome: DBus export failed: ${e.message}`);
        }
    }

    _unexportDbus() {
        if (this._dbusOwnerId) {
            Gio.bus_unown_name(this._dbusOwnerId);
            this._dbusOwnerId = 0;
        }
        if (this._dbusImpl) {
            try { this._dbusImpl.unexport(); } catch (_) {}
            this._dbusImpl = null;
        }
    }

    disable() {
        this._unexportDbus();

        for (const id of this._settingIds ?? [])
            this._settings.disconnect(id);
        this._settingIds = [];

        for (const id of this._clientSignalIds ?? [])
            this._client?.disconnect(id);
        this._clientSignalIds = [];

        if (this._startupCheckId) {
            GLib.source_remove(this._startupCheckId);
            this._startupCheckId = 0;
        }

        for (const key of this._boundShortcuts ?? [])
            Main.wm.removeKeybinding(key);
        this._boundShortcuts = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._client?.destroy();
        this._client = null;

        ToastManager.destroy();

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
                    if (!snap.canControl) this._client.setOperator();
                    else ToastManager.show({ level: 'info', message: 'Login required' });
                    return;
                }
                const toggle = this._indicator?._toggle;
                if (snap.running) {
                    toggle?._withFeedback(
                        'Disconnecting Tailscale',
                        'Tailscale disconnected',
                        () => this._client.down(),
                    );
                } else {
                    toggle?._withFeedback(
                        'Connecting Tailscale',
                        'Tailscale connected',
                        () => this._client.up(),
                    );
                }
            };
        case 'shortcut-toggle-exit-node':
            return () => {
                const snap = this._client.snapshot;
                const toggle = this._indicator?._toggle;
                if (snap.exitNodeID) {
                    toggle?._withFeedback(
                        'Clearing exit node',
                        'Exit node cleared',
                        () => this._client.setExitNode(''),
                    );
                } else {
                    toggle?._withFeedback(
                        'Selecting an exit node',
                        'Exit node: auto',
                        () => this._client.setExitNode('auto:any'),
                    );
                }
            };
        case 'shortcut-show-menu':
            return () => this._indicator?.openMenu();
        case 'shortcut-copy-self-ip':
            return () => {
                const ip = this._client.snapshot?.selfIps?.[0];
                if (!ip) {
                    ToastManager.show({ level: 'info', message: 'No Tailscale IP yet' });
                    return;
                }
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, ip);
                ToastManager.show({
                    level: 'success',
                    message: `Copied ${ip} to clipboard`,
                });
            };
        case 'shortcut-open-admin-panel':
            return () => openAdminPanel();
        case 'shortcut-send-file':
            return () => this._indicator?._toggle?._runSendFlow?.();
        default:
            return null;
        }
    }
}

export function openAdminPanel() {
    try {
        Gio.AppInfo.launch_default_for_uri(ADMIN_URL, null);
    } catch (e) {
        ToastManager.show({
            level: 'error',
            message: `Could not open ${ADMIN_URL}`,
        });
    }
}
