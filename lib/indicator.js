// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// SystemIndicator: owns the small icon that sits next to Wi-Fi in the panel
// and holds the QuickMenuToggle as a child.

import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import { TailscaleToggle } from './menu.js';
import { backendStatus } from './tailscale.js';
import { gicon as _gicon } from './util.js';

const ICON_ACTIVE    = 'tailscale-symbolic';
const ICON_DISABLED  = 'tailscale-disabled-symbolic';
// Themed: only the Tailscale logo is bundled. The pair reads as one state
// and its opposite — a tunnel that carries traffic, and one that does not.
const ICON_EXIT_WARN = 'network-vpn-disabled-symbolic';
const ICON_EXIT_OK   = 'network-vpn-symbolic';

const DEFAULT_WARN_COLOR = '#e6b800';

// The colour goes straight into an inline style, so it is checked against
// a #rrggbb literal first. A value edited by hand in dconf is otherwise
// free to carry arbitrary CSS into the panel.
function _safeColor(value) {
    return /^#[0-9a-fA-F]{6}$/.test(value) ? value : DEFAULT_WARN_COLOR;
}

// Same check, but an unset or unusable value means "no colour of our own"
// rather than a fallback of ours: the icon then takes the panel's own ink
// and follows a light or dark theme without being told to.
function _optionalColor(value) {
    return /^#[0-9a-fA-F]{6}$/.test(value) ? value : null;
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
            this._exitWarnIcon.icon_name = ICON_EXIT_WARN;
            this._exitWarnIcon.visible = false;

            // The other half of that state: an exit node that is actually
            // carrying traffic. Off by default — a working tunnel is the
            // quiet case — but worth showing for anyone who wants to see at
            // a glance which way their traffic is going.
            this._exitOkIcon = this._addIndicator();
            this._exitOkIcon.icon_name = ICON_EXIT_OK;
            this._exitOkIcon.visible = false;

            this._toggle = new TailscaleToggle({ extension, client });
            this.quickSettingsItems.push(this._toggle);

            this._client.connectObject(
                'state-changed', (_c, snap) => this._render(snap),
                this,
            );
            this._settings.connectObject(
                'changed::show-indicator',
                () => this._render(this._client.snapshot),
                'changed::show-exit-node-indicator',
                () => this._render(this._client.snapshot),
                'changed::exit-node-indicator-color',
                () => this._render(this._client.snapshot),
                'changed::show-exit-node-active-indicator',
                () => this._render(this._client.snapshot),
                'changed::exit-node-active-indicator-color',
                () => this._render(this._client.snapshot),
                this,
            );

            this._render(this._client.snapshot);
        }

        /** Programmatically open the Quick Settings menu and our submenu. */
        openMenu() {
            // The keybinding fires wherever the user is, so it reaches past
            // an arrow that is no longer on screen. It lands where the
            // click on that button lands: the preferences window, on the
            // page that explains why there is no menu.
            const snap = this._client.snapshot;
            if (backendStatus(snap) !== 'ready') {
                this._toggle.reportUnusableBackend(snap);
                return;
            }
            // Open the parent Quick Settings popup if it isn't already.
            const qs = Main.panel.statusArea.quickSettings;
            if (!qs.menu.isOpen)
                qs.menu.open();
            // QuickMenuToggle's secondary menu opens via its 'menu-enabled'
            // arrow; opening it directly is the cleanest way.
            if (!this._toggle.menu.isOpen)
                this._toggle.menu.open();
        }

        /** Entry point for the DBus SendFiles method and the shortcut. */
        sendFiles(files) {
            this._toggle.runSendFlow(files);
        }

        /** Entry point for the shortcut. Opens the Funnels dialog. */
        openFunnels() {
            this._toggle.openFunnels();
        }

        _render(snap) {
            const running = snap.running;

            this._panelIcon.gicon = _gicon(
                this._extension,
                running ? ICON_ACTIVE : ICON_DISABLED,
            );
            this._panelIcon.visible =
                this._settings.get_boolean('show-indicator') && running;

            // An exit node selection is broken when the user asked for
            // one (Auto or Direct) but the currently-picked peer can't
            // route — offline or no longer advertising as an exit. That
            // state costs the device its internet access, so it has its
            // own switch and does not hide with the connection icon.
            const wantsExit = running && !!(snap.autoExitNode || snap.exitNodeID);
            const cur = snap.currentExitNode;
            const reachable = !!(cur && cur.online && cur.exitNodeOption);
            this._exitWarnIcon.visible =
                this._settings.get_boolean('show-exit-node-indicator') &&
                wantsExit && !reachable;
            this._exitWarnIcon.set_style(
                `color: ${_safeColor(
                    this._settings.get_string('exit-node-indicator-color'),
                )};`,
            );

            // Mutually exclusive with the warning by construction: the two
            // are the same condition read either way round, so the panel
            // never carries both.
            this._exitOkIcon.visible =
                this._settings.get_boolean('show-exit-node-active-indicator') &&
                wantsExit && reachable;
            const okColor = _optionalColor(
                this._settings.get_string('exit-node-active-indicator-color'));
            // null, not an empty declaration: clearing the style is what
            // hands the icon back to the panel's own colour.
            this._exitOkIcon.set_style(okColor ? `color: ${okColor};` : null);
        }

        destroy() {
            this._client.disconnectObject(this);
            this._settings.disconnectObject(this);
            this.quickSettingsItems.forEach((it) => it.destroy());
            this.quickSettingsItems = [];
            super.destroy();
        }
    },
);
