// QuickMenuToggle for Tailscale.
//
// Reactive menu — re-renders only when the client's snapshot signals
// 'state-changed'. Clicking the toggle body flips Tailscale on/off via the
// canonical `toggleMode: true` pattern: `checked` toggles synchronously, the
// 'clicked' signal fires, and we dispatch up()/down() based on the *new*
// `this.checked` value. When the action fails (e.g. operator-not-set), the
// next snapshot poll snaps `checked` back to the daemon's truth.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
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
 * Non-reactive info row: left label + right accessory, optionally pill-styled.
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
        setText(t) { this._label.text = t; }
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
 * Activatable banner row used to surface a fatal error (e.g. operator-not-set).
 * Click copies a remediation command to the clipboard.
 */
const BannerRow = GObject.registerClass(
    class BannerRow extends PopupMenu.PopupBaseMenuItem {
        _init() {
            super._init();
            const box = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._title = new St.Label({ text: '' });
            this._sub = new St.Label({
                text: '',
                style_class: 'tailscale-peer-ip',
            });
            box.add_child(this._title);
            box.add_child(this._sub);
            this.add_child(box);
        }
        set(title, hint) {
            this._title.text = title;
            this._sub.text = hint;
        }
    },
);

/**
 * Ornament-driven check row — checkbox-like menu entry.
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
        setSensitive(v) {
            this.reactive = !!v;
            this.can_focus = !!v;
            this._label.opacity = v ? 255 : 128;
        }
    },
);

/**
 * Peer/account/exit-node row with optional online dot, IP subtitle, and check.
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
            box.add_child(new St.Label({ text: title }));
            if (subtitle) {
                box.add_child(new St.Label({
                    text: subtitle,
                    style_class: 'tailscale-peer-ip',
                }));
            }
            this.add_child(box);

            if (online !== undefined) {
                this.add_child(new St.Label({
                    text: online ? '●' : '○',
                    y_align: Clutter.ActorAlign.CENTER,
                    style: `color: ${online ? '#66d68a' : '#888'}; margin-left: 6px;`,
                }));
                if (!online) this.add_style_class_name('tailscale-peer-offline');
            }

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
                gicon: _gicon(extension, ICON_DISABLED),
                // toggleMode: true → click flips `checked` synchronously and
                // emits 'clicked'. The next snapshot reverts `checked` to the
                // daemon's truth on failure (e.g. operator-not-set).
                toggleMode: true,
            });

            this._extension     = extension;
            this._client        = client;
            this._settings      = extension.getSettings();
            this._signalIds     = [];
            this._settingsIds   = [];

            this._signalIds.push(
                this.connect('clicked', () => this._onUserClick()),
            );

            this._signalIds.push(
                this._client.connect('state-changed', (_c, snap) => this._render(snap)),
                this._client.connect('error', (_c, msg) =>
                    Main.notifyError('Tailscale', msg)),
            );

            this._settingsIds.push(
                this._settings.connect('changed::show-subtitle', () =>
                    this._render(this._client.snapshot)),
            );

            this.menu.setHeader(
                _gicon(extension, ICON_DISABLED),
                'Tailscale',
                _('Disconnected'),
            );

            this._buildMenu();
            this._render(this._client.snapshot);
        }

        /* --------------------------- menu skeleton ------------------------ */
        //
        // Order (compact):
        //   IP row
        //   Account submenu       ← shows current account in its label
        //   ─────
        //   Exit node submenu
        //   Peers submenu
        //   ─────
        //   5 × toggle rows
        //   ─────
        //   Refresh / Settings…
        //
        // A BannerRow is inserted above the IP row when canControl is false
        // (operator-not-set scenario).

        _buildMenu() {
            this._banner = new BannerRow();
            this._banner.visible = false;
            this.menu.addMenuItem(this._banner);

            this._ipRow = new InfoRow(_('IP'), '—');
            this.menu.addMenuItem(this._ipRow);

            this._accountsSubMenu = new PopupMenu.PopupSubMenuMenuItem(_('Account'), true);
            this.menu.addMenuItem(this._accountsSubMenu);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._exitNodeSubMenu = new PopupMenu.PopupSubMenuMenuItem(
                _('Exit node: none'), true);
            this.menu.addMenuItem(this._exitNodeSubMenu);

            this._peersSubMenu = new PopupMenu.PopupSubMenuMenuItem(_('Peers'), true);
            this.menu.addMenuItem(this._peersSubMenu);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._acceptRoutesRow = new ToggleRow(_('Accept routes'),    (v) => this._client.setAcceptRoutes(v));
            this._acceptDNSRow    = new ToggleRow(_('Accept DNS'),       (v) => this._client.setAcceptDNS(v));
            this._allowLanRow     = new ToggleRow(_('Allow LAN access'), (v) => this._client.setAllowLanAccess(v));
            this._shieldsUpRow    = new ToggleRow(_('Shields up'),       (v) => this._client.setShieldsUp(v));
            this._runSSHRow       = new ToggleRow(_('Run SSH server'),   (v) => this._client.setRunSSH(v));
            for (const r of [this._acceptRoutesRow, this._acceptDNSRow,
                this._allowLanRow, this._shieldsUpRow, this._runSSHRow])
                this.menu.addMenuItem(r);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this.menu.addAction(_('Refresh'), () => this._client.refresh());
            const settingsItem = this.menu.addAction(_('Tailscale Settings…'),
                () => this._extension.openPreferences());
            settingsItem.visible = Main.sessionMode.allowSettings;
            this.menu._settingsActions = this.menu._settingsActions ?? {};
            this.menu._settingsActions[this._extension.uuid] = settingsItem;
        }

        /* ----------------------------- actions ---------------------------- */

        _onUserClick() {
            // With toggleMode: true, `this.checked` already reflects the user's
            // intent (it was flipped before the signal fired). Dispatch on it.
            const snap = this._client.snapshot;
            if (this.checked) {
                if (snap.loggedOut || snap.backendState === 'NeedsLogin')
                    this._client.login();
                else
                    this._client.up();
            } else {
                this._client.down();
            }
        }

        /* ------------------------------ render ---------------------------- */

        _render(snap) {
            if (!snap) return;
            const showSub = this._settings.get_boolean('show-subtitle');

            // Toggle visual state — snap to daemon truth (auto-revert on
            // failed user clicks).
            this.checked = snap.running;
            this.gicon = _gicon(this._extension, snap.running ? ICON_ACTIVE : ICON_DISABLED);

            // Subtitle.
            const subtitle = this._statusText(snap);
            this.subtitle = showSub ? subtitle : '';

            // Header.
            this.menu.setHeader(
                _gicon(this._extension, snap.running ? ICON_ACTIVE : ICON_DISABLED),
                'Tailscale',
                snap.hostname ? `${snap.hostname} • ${subtitle}` : subtitle,
            );

            // Operator banner.
            if (!snap.canControl) {
                this._banner.set(
                    _('Operator not set'),
                    _('Click here to copy: sudo tailscale set --operator=$USER'),
                );
                this._banner.visible = true;
                this._banner.reactive = true;
                if (!this._bannerHandler) {
                    this._bannerHandler = this._banner.connect('activate', () => {
                        const cmd = `sudo tailscale set --operator=${GLib.get_user_name()}`;
                        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, cmd);
                        Main.notify('Tailscale', _('Command copied to clipboard'));
                    });
                }
            } else {
                this._banner.visible = false;
            }

            // IP row.
            this._ipRow.setText(_('IP'));
            this._ipRow.setAccessory(snap.selfIps?.[0] ?? '—');
            this._ipRow.setOnline(snap.running);

            // Submenus + toggles.
            this._renderAccounts(snap);
            this._renderExitNodes(snap);
            this._renderPeers(snap);

            const sensitive = !!snap.canControl;
            for (const r of [this._acceptRoutesRow, this._acceptDNSRow,
                this._allowLanRow, this._shieldsUpRow, this._runSSHRow])
                r.setSensitive(sensitive);

            this._acceptRoutesRow.setChecked(snap.acceptRoutes);
            this._acceptDNSRow.setChecked(snap.acceptDNS);
            this._allowLanRow.setChecked(snap.allowLanAccess);
            this._shieldsUpRow.setChecked(snap.shieldsUp);
            this._runSSHRow.setChecked(snap.runSSH);
        }

        _statusText(snap) {
            if (snap.error)                              return _('Tailscale unavailable');
            if (snap.loggedOut)                          return _('Logged out');
            if (snap.backendState === 'NeedsLogin')      return _('Login required');
            if (snap.running)                            return snap.accountName || _('Connected');
            return _('Disconnected');
        }

        _renderExitNodes(snap) {
            const sub = this._exitNodeSubMenu.menu;
            sub.removeAll();

            const current = snap.currentExitNode;
            const label = current
                ? _fmt(_('Exit node: %s'), current.hostname || current.dnsName)
                : (snap.exitNodeID ? _('Exit node: auto') : _('Exit node: none'));
            this._exitNodeSubMenu.label.text = label;

            sub.addMenuItem(new PeerRow({
                title: _('None (direct)'),
                checked: !snap.exitNodeID,
                onClick: () => this._client.setExitNode(''),
            }));
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
                sub.addMenuItem(new PeerRow({
                    title: peer.hostname || peer.dnsName,
                    subtitle: peer.ips[0] ?? '',
                    online: peer.online,
                    checked: peer.exitNode,
                    styleClass: peer.exitNode ? 'tailscale-exit-node-active' : '',
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

            // Submenu label = current account (collapsed preview).
            const currentFromList = snap.accounts.find((a) => a.current);
            const currentLabel =
                currentFromList?.account ||
                snap.accountName ||
                _('No account');
            this._accountsSubMenu.label.text = _fmt(_('Account: %s'), currentLabel);

            if (snap.accounts.length === 0) {
                // switch --list was either denied or empty. Show whatever the
                // status JSON tells us as a read-only entry, plus a hint.
                if (snap.accountName) {
                    const row = new PeerRow({
                        title: snap.accountName,
                        subtitle: snap.tailnetName !== snap.accountName ? snap.tailnetName : '',
                        checked: true,
                    });
                    row.reactive = false;
                    sub.addMenuItem(row);
                }
                if (!snap.canControl) {
                    const hint = new InfoRow(_('Operator not set — switching disabled'));
                    hint.reactive = false;
                    sub.addMenuItem(hint);
                }
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
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
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
