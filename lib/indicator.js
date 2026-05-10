// SystemIndicator — owns the small icon that sits next to Wi-Fi in the panel
// and holds the QuickMenuToggle as a child.

import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

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

            this._toggle = new TailscaleToggle({ extension, client });
            this.quickSettingsItems.push(this._toggle);

            this._signalIds = [];
            this._signalIds.push(
                this._client.connect('state-changed', (_c, snap) => this._render(snap)),
            );
            this._settingsIds = [
                this._settings.connect('changed::show-indicator',          () => this._render(this._client.snapshot)),
                this._settings.connect('changed::indicator-always-visible', () => this._render(this._client.snapshot)),
            ];

            this._render(this._client.snapshot);
        }

        _render(snap) {
            const show       = this._settings.get_boolean('show-indicator');
            const alwaysOn   = this._settings.get_boolean('indicator-always-visible');
            const running    = !!snap?.running;

            this._panelIcon.gicon = _gicon(
                this._extension,
                running ? ICON_ACTIVE : ICON_DISABLED,
            );

            if (!show) {
                this._panelIcon.visible = false;
                return;
            }
            this._panelIcon.visible = running || alwaysOn;

            this._panelIcon.remove_style_class_name('tailscale-indicator-stopped');
            if (!running)
                this._panelIcon.add_style_class_name('tailscale-indicator-stopped');
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
