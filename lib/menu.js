// QuickMenuToggle for Tailscale.
//
// A reactive menu that re-renders only when the client's snapshot
// signals 'state-changed'. The toggle button itself toggles tailscale up/down.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

const ICON_ACTIVE   = 'tailscale-symbolic';
const ICON_DISABLED = 'tailscale-disabled-symbolic';

function _gicon(extension, name) {
    return new Gio.FileIcon({
        file: extension.dir.get_child('icons').get_child(`${name}.svg`),
    });
}

// printf-style %s / %d substitution. Replaces String.prototype.format which
// isn't part of standard ESM JS in GJS.
function _fmt(template, ...args) {
    let i = 0;
    return template.replace(/%[sd]/g, () => {
        const v = args[i++];
        return v === undefined || v === null ? '' : String(v);
    });
}

/* -------------------------------------------------------------------------- */
/*                              Helper widgets                                */
/* -------------------------------------------------------------------------- */

/**
 * A header-like, non-clickable info row inside a section.
 * Shows a label and an optional accessory label (e.g. an IP).
 */
const InfoRow = GObject.registerClass(
    class InfoRow extends PopupMenu.PopupBaseMenuItem {
        _init(text, accessory = null, opts = {}) {
            super._init({ reactive: false, style_class: opts.styleClass ?? '' });
            this._label = new St.Label({
                text,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this._label);
            this._accessory = null;
            if (accessory) this.setAccessory(accessory);
        }
        setText(t)      { this._label.text = t; }
        setAccessory(t) {
            if (!this._accessory) {
                this._accessory = new St.Label({
                    style_class: 'tailscale-status-pill',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                this.add_child(this._accessory);
            }
            this._accessory.text = t;
        }
        setOnline(online) {
            if (!this._accessory) return;
            this._accessory.remove_style_class_name('online');
            this._accessory.remove_style_class_name('offline');
            this._accessory.add_style_class_name(online ? 'online' : 'offline');
        }
    },
);

/**
 * Ornament-driven "checkbox" row: shows a check mark when checked.
 * Activating toggles via the supplied callback.
 */
const ToggleRow = GObject.registerClass(
    class ToggleRow extends PopupMenu.PopupBaseMenuItem {
        _init(text, onActivate) {
            super._init();
            this._label = new St.Label({
                text,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this._label);
            this._onActivate = onActivate;
            this.connect('activate', () => this._onActivate?.(!this._checked));
            this._checked = false;
            this.setOrnament(PopupMenu.Ornament.NONE);
        }
        setChecked(v) {
            this._checked = !!v;
            this.setOrnament(v ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
    },
);

/**
 * A single peer row inside a sub-menu. Activating triggers `onClick`.
 * Optionally shows a check ornament (for the active exit node), an accessory
 * label (for status text), and a secondary line with the IP.
 */
const PeerRow = GObject.registerClass(
    class PeerRow extends PopupMenu.PopupBaseMenuItem {
        _init({ title, subtitle, online, checked, onClick, styleClass }) {
            super._init({ style_class: styleClass ?? '' });

            const box = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._title = new St.Label({ text: title });
            box.add_child(this._title);
            if (subtitle) {
                this._sub = new St.Label({
                    text: subtitle,
                    style_class: 'tailscale-peer-ip',
                });
                box.add_child(this._sub);
            }
            this.add_child(box);

            if (online !== undefined) {
                this._dot = new St.Label({
                    text: online ? '●' : '○',
                    y_align: Clutter.ActorAlign.CENTER,
                    style: `color: ${online ? '#66d68a' : '#888'}; margin-left: 6px;`,
                });
                this.add_child(this._dot);
            }
            if (!online) this.add_style_class_name('tailscale-peer-offline');

            this.setOrnament(checked ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            this.connect('activate', () => onClick?.());
        }
    },
);

/* -------------------------------------------------------------------------- */
/*                            QuickMenuToggle                                 */
/* -------------------------------------------------------------------------- */

export const TailscaleToggle = GObject.registerClass(
    class TailscaleToggle extends QuickSettings.QuickMenuToggle {
        _init({ extension, client }) {
            super._init({
                title: 'Tailscale',
                subtitle: _('Loading…'),
                gicon: _gicon(extension, ICON_ACTIVE),
                toggleMode: false,
            });

            this._extension     = extension;
            this._client        = client;
            this._settings      = extension.getSettings();
            this._signalIds     = [];
            this._settingsIds   = [];

            // Toggle action: click on tile body flips the connection.
            this._signalIds.push(
                this.connect('clicked', () => this._onToggleClicked()),
            );

            // Live state.
            this._signalIds.push(
                this._client.connect('state-changed', (_c, snap) => this._render(snap)),
            );

            // Settings: subtitle visibility.
            this._settingsIds.push(
                this._settings.connect('changed::show-subtitle', () =>
                    this._render(this._client.snapshot),
                ),
            );

            // Build the menu skeleton (rows are added once, then mutated).
            this.menu.setHeader(_gicon(extension, ICON_ACTIVE), 'Tailscale', _('Disconnected'));
            this._buildMenu();

            // Initial render with whatever the client already has.
            this._render(this._client.snapshot);
        }

        /* --------------------------- menu skeleton ------------------------ */

        _buildMenu() {
            // Self info row (account, IP).
            this._selfRow = new InfoRow(_('Account'), '—');
            this.menu.addMenuItem(this._selfRow);
            this._ipRow = new InfoRow(_('IP'), '—');
            this.menu.addMenuItem(this._ipRow);

            // Quick action: toggle connect/disconnect.
            this._connectAction = this.menu.addAction(_('Connect'), () =>
                this._onToggleClicked(),
            );

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            /* --------------------------- exit nodes ----------------------- */
            this._exitNodeSubMenu = new PopupMenu.PopupSubMenuMenuItem(
                _('Exit node: none'),
                true,
            );
            this.menu.addMenuItem(this._exitNodeSubMenu);

            /* ----------------------------- peers -------------------------- */
            this._peersSubMenu = new PopupMenu.PopupSubMenuMenuItem(
                _('Peers'),
                true,
            );
            this.menu.addMenuItem(this._peersSubMenu);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            /* ------------------------- preferences ------------------------ */
            this._acceptRoutesRow   = new ToggleRow(_('Accept routes'),       (v) => this._client.setAcceptRoutes(v));
            this._acceptDNSRow      = new ToggleRow(_('Accept DNS'),          (v) => this._client.setAcceptDNS(v));
            this._allowLanRow       = new ToggleRow(_('Allow LAN access'),    (v) => this._client.setAllowLanAccess(v));
            this._shieldsUpRow      = new ToggleRow(_('Shields up'),          (v) => this._client.setShieldsUp(v));
            this._runSSHRow         = new ToggleRow(_('Run SSH server'),      (v) => this._client.setRunSSH(v));
            for (const row of [this._acceptRoutesRow, this._acceptDNSRow,
                this._allowLanRow, this._shieldsUpRow, this._runSSHRow])
                this.menu.addMenuItem(row);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            /* ---------------------------- accounts ------------------------ */
            this._accountsSubMenu = new PopupMenu.PopupSubMenuMenuItem(
                _('Account'),
                true,
            );
            this.menu.addMenuItem(this._accountsSubMenu);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            /* ----------------------------- footer ------------------------- */
            this.menu.addAction(_('Refresh'), () => this._client.refresh());
            const settingsItem = this.menu.addAction(_('Tailscale Settings…'), () =>
                this._extension.openPreferences(),
            );
            // Hide settings when the screen is locked.
            settingsItem.visible = Main.sessionMode.allowSettings;
            this.menu._settingsActions = this.menu._settingsActions ?? {};
            this.menu._settingsActions[this._extension.uuid] = settingsItem;
        }

        /* ----------------------------- actions ---------------------------- */

        async _onToggleClicked() {
            const snap = this._client.snapshot;
            if (snap.running) {
                await this._client.down();
            } else if (snap.loggedOut) {
                await this._client.login();
            } else {
                await this._client.up();
            }
        }

        /* ------------------------------ render ---------------------------- */

        _render(snap) {
            if (!snap) return;
            const showSub = this._settings.get_boolean('show-subtitle');

            // Toggle visual state.
            this.checked = snap.running;
            this.gicon   = _gicon(this._extension, snap.running ? ICON_ACTIVE : ICON_DISABLED);

            // Subtitle string.
            let subtitle;
            if (snap.error)              subtitle = _('Tailscale unavailable');
            else if (snap.loggedOut)     subtitle = _('Logged out');
            else if (snap.running)       subtitle = snap.accountName || _('Connected');
            else if (snap.backendState === 'NeedsLogin') subtitle = _('Login required');
            else                         subtitle = _('Disconnected');
            this.subtitle = showSub ? subtitle : '';

            // Header.
            this.menu.setHeader(
                _gicon(this._extension, snap.running ? ICON_ACTIVE : ICON_DISABLED),
                'Tailscale',
                snap.hostname
                    ? `${snap.hostname}  •  ${subtitle}`
                    : subtitle,
            );

            // Self rows.
            this._selfRow.setText(_('Account'));
            this._selfRow.setAccessory(snap.accountName || '—');
            this._selfRow.setOnline(snap.running);

            this._ipRow.setText(_('IP'));
            this._ipRow.setAccessory(snap.selfIps?.[0] ?? '—');
            this._ipRow.setOnline(snap.running);

            // Connect action label.
            if (snap.error) {
                this._connectAction.label.text = _('Retry');
            } else if (snap.running) {
                this._connectAction.label.text = _('Disconnect');
            } else if (snap.loggedOut) {
                this._connectAction.label.text = _('Login…');
            } else if (snap.backendState === 'NeedsLogin') {
                this._connectAction.label.text = _('Login…');
            } else {
                this._connectAction.label.text = _('Connect');
            }

            // Exit nodes.
            this._renderExitNodes(snap);

            // Peers.
            this._renderPeers(snap);

            // Toggles (RouteAll etc.).
            this._acceptRoutesRow.setChecked(snap.acceptRoutes);
            this._acceptDNSRow.setChecked(snap.acceptDNS);
            this._allowLanRow.setChecked(snap.allowLanAccess);
            this._shieldsUpRow.setChecked(snap.shieldsUp);
            this._runSSHRow.setChecked(snap.runSSH);

            // Accounts.
            this._renderAccounts(snap);
        }

        _renderExitNodes(snap) {
            const sub = this._exitNodeSubMenu.menu;
            sub.removeAll();

            const current = snap.currentExitNode;
            const label = current
                ? _fmt(_('Exit node: %s'), current.hostname || current.dnsName)
                : (snap.exitNodeID ? _('Exit node: auto') : _('Exit node: none'));
            this._exitNodeSubMenu.label.text = label;

            // None.
            sub.addMenuItem(new PeerRow({
                title: _('None (direct)'),
                checked: !snap.exitNodeID,
                onClick: () => this._client.setExitNode(''),
            }));

            // Auto.
            sub.addMenuItem(new PeerRow({
                title: _('Automatic'),
                subtitle: 'auto:any',
                checked: snap.exitNodeID === 'auto:any',
                onClick: () => this._client.setExitNode('auto:any'),
            }));

            if (snap.exitNodes.length === 0) {
                const empty = new InfoRow(_('No exit nodes available'));
                empty.reactive = false;
                sub.addMenuItem(empty);
                return;
            }

            sub.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            for (const peer of snap.exitNodes) {
                const styleClass = peer.exitNode ? 'tailscale-exit-node-active' : '';
                sub.addMenuItem(new PeerRow({
                    title: peer.hostname || peer.dnsName,
                    subtitle: peer.ips[0] ?? '',
                    online: peer.online,
                    checked: peer.exitNode,
                    styleClass,
                    onClick: () =>
                        this._client.setExitNode(peer.hostname || peer.ips[0]),
                }));
            }
        }

        _renderPeers(snap) {
            const sub = this._peersSubMenu.menu;
            sub.removeAll();

            const total  = snap.peers.length;
            const online = snap.peers.filter((p) => p.online).length;
            this._peersSubMenu.label.text = total
                ? _fmt(_('Peers (%d/%d online)'), online, total)
                : _('Peers');

            if (total === 0) {
                const empty = new InfoRow(_('No peers'));
                empty.reactive = false;
                sub.addMenuItem(empty);
                return;
            }

            for (const peer of snap.peers) {
                const ip = peer.ips[0] ?? '';
                sub.addMenuItem(new PeerRow({
                    title: peer.hostname || peer.dnsName,
                    subtitle: ip ? `${ip} • ${peer.os || ''}`.trim() : peer.os,
                    online: peer.online,
                    onClick: () => this._copyToClipboard(ip || peer.dnsName),
                }));
            }
        }

        _renderAccounts(snap) {
            const sub = this._accountsSubMenu.menu;
            sub.removeAll();

            const current = snap.accounts.find((a) => a.current);
            this._accountsSubMenu.label.text = current
                ? _fmt(_('Account: %s'), current.account)
                : _('Account');

            if (snap.accounts.length === 0) {
                const empty = new InfoRow(_('No accounts'));
                empty.reactive = false;
                sub.addMenuItem(empty);
            } else {
                for (const acc of snap.accounts) {
                    sub.addMenuItem(new PeerRow({
                        title: acc.account,
                        subtitle: acc.tailnet !== acc.account ? acc.tailnet : '',
                        checked: acc.current,
                        onClick: () => {
                            if (!acc.current) this._client.switchAccount(acc.id);
                        },
                    }));
                }
            }

            sub.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            sub.addAction(_('Login (new account)…'), () => this._client.login());
            if (!snap.loggedOut)
                sub.addAction(_('Logout'), () => this._client.logout());
        }

        /* --------------------------- helpers ------------------------------ */

        _copyToClipboard(text) {
            if (!text) return;
            const clipboard = St.Clipboard.get_default();
            clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
            Main.notify('Tailscale', _fmt(_('Copied %s to clipboard'), text));
        }

        destroy() {
            for (const id of this._signalIds)   this._client.disconnect(id);
            for (const id of this._settingsIds) this._settings.disconnect(id);
            this._signalIds = [];
            this._settingsIds = [];
            super.destroy();
        }
    },
);
