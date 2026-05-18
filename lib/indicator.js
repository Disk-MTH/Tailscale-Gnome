// SystemIndicator: owns the small icon that sits next to Wi-Fi in the panel
// and holds the QuickMenuToggle as a child.

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import { TailscaleToggle } from './menu.js';

const ICON_ACTIVE   = 'tailscale-symbolic';
const ICON_DISABLED = 'tailscale-disabled-symbolic';

function _gicon(extension, name) {
    return new Gio.FileIcon({
        file: extension.dir.get_child('icons').get_child(`${name}.svg`),
    });
}

export const TailscaleIndicator = GObject.registerClass(
    class TailscaleIndicator extends QuickSettings.SystemIndicator {
        _init({ extension, client }) {
            super._init();

            this._extension = extension;
            this._client    = client;
            this._settings  = extension.getSettings();

            this._panelIcon = this._addIndicator();
            this._panelIcon.gicon = _gicon(extension, ICON_ACTIVE);
            this._panelIcon.visible = false;

            // Secondary icon shown next to the Tailscale logo when an
            // exit node is selected (Auto or Direct) but unreachable —
            // the daemon keeps routing through the dead tunnel, so the
            // user has no internet until they switch or clear it.
            this._exitWarnIcon = this._addIndicator();
            this._exitWarnIcon.icon_name = 'network-vpn-disconnected-symbolic';
            this._exitWarnIcon.visible = false;

            this._toggle = new TailscaleToggle({ extension, client });
            this.quickSettingsItems.push(this._toggle);

            this._signalIds = [];
            this._signalIds.push(
                this._client.connect('state-changed', (_c, snap) => this._render(snap)),
            );
            this._settingsIds = [
                this._settings.connect('changed::show-indicator', () =>
                    this._render(this._client.snapshot)),
            ];

            this._render(this._client.snapshot);
        }

        /** Programmatically open the Quick Settings menu and our submenu. */
        openMenu() {
            // Open the parent Quick Settings popup if it isn't already.
            const qs = Main.panel.statusArea.quickSettings;
            if (qs?.menu && !qs.menu.isOpen)
                qs.menu.open();
            // QuickMenuToggle's secondary menu opens via its 'menu-enabled'
            // arrow; opening it directly is the cleanest way.
            if (this._toggle?.menu && !this._toggle.menu.isOpen)
                this._toggle.menu.open();
        }

        _render(snap) {
            const show    = this._settings.get_boolean('show-indicator');
            const running = !!snap?.running;

            this._panelIcon.gicon = _gicon(
                this._extension,
                running ? ICON_ACTIVE : ICON_DISABLED,
            );
            this._panelIcon.visible = show && running;

            // An exit node selection is broken when the user asked for
            // one (Auto or Direct) but the currently-picked peer can't
            // route — offline or no longer advertising as an exit. The
            // pill already surfaces this; the panel warning makes it
            // visible without opening the menu.
            const wantsExit = running && !!(snap?.autoExitNode || snap?.exitNodeID);
            const cur = snap?.currentExitNode;
            const reachable = !!(cur && cur.online && cur.exitNodeOption);
            this._exitWarnIcon.visible = show && wantsExit && !reachable;
        }

        destroy() {
            for (const id of this._signalIds)   this._client.disconnect(id);
            for (const id of this._settingsIds) this._settings.disconnect(id);
            this._signalIds = [];
            this._settingsIds = [];
            this.quickSettingsItems.forEach((it) => it.destroy());
            this.quickSettingsItems = [];
            super.destroy();
        }
    },
);
