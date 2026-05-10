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

// Keys backed by `as` arrays in the GSettings schema. Each key holds zero or
// one accelerators (e.g. ["<Super>t"]). Empty array = unbound.
const SHORTCUT_KEYS = [
    'shortcut-toggle-tailscale',
    'shortcut-toggle-exit-node',
    'shortcut-show-menu',
    'shortcut-copy-self-ip',
    'shortcut-open-admin-panel',
];

const ADMIN_URL = 'https://login.tailscale.com/admin/machines';

export default class TailscaleGnomeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        this._client = new TailscaleClient({
            binary:      this._settings.get_string('tailscale-binary') || 'tailscale',
            pollSeconds: this._settings.get_int('poll-interval'),
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
    }

    disable() {
        for (const id of this._settingIds ?? [])
            this._settings.disconnect(id);
        this._settingIds = [];

        for (const key of this._boundShortcuts ?? [])
            Main.wm.removeKeybinding(key);
        this._boundShortcuts = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._client?.destroy();
        this._client = null;

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
                if (snap.running) this._client.down();
                else if (snap.loggedOut || snap.backendState === 'NeedsLogin') this._client.login();
                else this._client.up();
            };
        case 'shortcut-toggle-exit-node':
            return () => {
                const snap = this._client.snapshot;
                this._client.setExitNode(snap.exitNodeID ? '' : 'auto:any');
            };
        case 'shortcut-show-menu':
            return () => this._indicator?.openMenu();
        case 'shortcut-copy-self-ip':
            return () => {
                const ip = this._client.snapshot?.selfIps?.[0];
                if (!ip) {
                    Main.notify('Tailscale', 'No Tailscale IP yet');
                    return;
                }
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, ip);
                Main.notify('Tailscale', `Copied ${ip} to clipboard`);
            };
        case 'shortcut-open-admin-panel':
            return () => openAdminPanel();
        default:
            return null;
        }
    }
}

export function openAdminPanel() {
    try {
        Gio.AppInfo.launch_default_for_uri(ADMIN_URL, null);
    } catch (e) {
        Main.notify('Tailscale', `Could not open ${ADMIN_URL}`);
    }
}
