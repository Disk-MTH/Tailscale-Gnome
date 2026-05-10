// QuickMenuToggle for Tailscale.
//
// Reactive menu. Re-renders only when the client's snapshot signals
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

const TAILSCALE_ADMIN_URL = 'https://login.tailscale.com/admin/machines';

const ICON_ACTIVE   = 'tailscale-symbolic';
const ICON_DISABLED = 'tailscale-disabled-symbolic';

function _gicon(extension, name) {
    return new Gio.FileIcon({
        file: extension.dir.get_child('icons').get_child(`${name}.svg`),
    });
}

// Decorate a PopupSubMenuMenuItem with a right-side pill, inserted between
// the title label and the dropdown arrow. The label is forced to x_expand so
// the pill ends up flush right. Returns the pill so callers can update it.
function _decorateWithPill(submenuItem) {
    submenuItem.label.x_expand = true;
    submenuItem.label.y_align = Clutter.ActorAlign.CENTER;
    const pill = new St.Label({
        style_class: 'tailscale-status-pill',
        y_align: Clutter.ActorAlign.CENTER,
    });
    pill.visible = false;
    if (submenuItem._triangleBin)
        submenuItem.insert_child_below(pill, submenuItem._triangleBin);
    else
        submenuItem.add_child(pill);
    return pill;
}

function _openAdminPanel() {
    try {
        Gio.AppInfo.launch_default_for_uri(TAILSCALE_ADMIN_URL, null);
    } catch (e) {
        Main.notifyError('Tailscale', `Could not open ${TAILSCALE_ADMIN_URL}`);
    }
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
 * Ornament-driven check row. Checkbox-like menu entry with an optional
 * right-side pill accessory (e.g. "1 advertised route", "hair-acoustic.ts.net").
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
            this._accessory = null;
            this._onActivate = onActivate;
            this._checked = false;
            this.setOrnament(PopupMenu.Ornament.NONE);
        }
        // Override activate so toggling the row does NOT close the parent menu.
        // PopupBaseMenuItem.activate() only emits the 'activate' signal, but
        // PopupMenuBase listens for it and calls top-menu.close() on every
        // child activation. Skipping the emit keeps the menu open so users
        // can flip several toggles in one go.
        activate(_event) {
            this._onActivate?.(!this._checked);
        }
        setChecked(v) {
            this._checked = !!v;
            this.setOrnament(v ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
        setSensitive(v) {
            this.reactive = !!v;
            this.can_focus = !!v;
            this._label.opacity = v ? 255 : 128;
            if (this._accessory) this._accessory.opacity = v ? 230 : 128;
        }
        setAccessory(text) {
            if (!text) {
                if (this._accessory) this._accessory.text = '';
                return;
            }
            if (!this._accessory) {
                this._accessory = new St.Label({
                    style_class: 'tailscale-status-pill',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                this.add_child(this._accessory);
            }
            this._accessory.text = text;
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
        //   [banner if !canControl]
        //   IP row
        //   Account submenu               (current account in label)
        //   ─────
        //   Peers submenu
        //   Exit node submenu             (Allow LAN lives inside, when active)
        //   ─────
        //   ☑ Accept DNS    [suffix]
        //   ☑ Accept routes [N advertised]
        //   ☐ Shields up
        //   ☐ Run SSH server
        //   ─────
        //   Tailnet routes submenu        (only when AcceptRoutes ON + non-empty)
        //   ─────
        //   Refresh
        //   Extension settings

        _buildMenu() {
            this._banner = new BannerRow();
            this._banner.visible = false;
            this.menu.addMenuItem(this._banner);

            this._ipRow = new InfoRow(_('IP'), '-');
            this.menu.addMenuItem(this._ipRow);

            this._accountsSubMenu = new PopupMenu.PopupSubMenuMenuItem(_('Account'), true);
            this.menu.addMenuItem(this._accountsSubMenu);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._peersSubMenu = new PopupMenu.PopupSubMenuMenuItem(_('Peers'), true);
            this._peersPill = _decorateWithPill(this._peersSubMenu);
            this.menu.addMenuItem(this._peersSubMenu);

            this._exitNodeSubMenu = new PopupMenu.PopupSubMenuMenuItem(
                _('Exit node'), true);
            this._exitNodePill = _decorateWithPill(this._exitNodeSubMenu);
            this.menu.addMenuItem(this._exitNodeSubMenu);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // DNS first, then Routes (DNS is the more common toggle).
            this._acceptDNSRow    = new ToggleRow(_('Accept DNS'),    (v) => this._client.setAcceptDNS(v));
            this._acceptRoutesRow = new ToggleRow(_('Accept routes'), (v) => this._client.setAcceptRoutes(v));
            this._shieldsUpRow    = new ToggleRow(_('Shields up'),    (v) => this._client.setShieldsUp(v));
            this._runSSHRow       = new ToggleRow(_('Run SSH server'), (v) => this._client.setRunSSH(v));
            for (const r of [this._acceptDNSRow, this._acceptRoutesRow,
                this._shieldsUpRow, this._runSSHRow])
                this.menu.addMenuItem(r);

            // Allow LAN lives inside the Exit node submenu now (it only has
            // meaning when an exit node is active). It gets built fresh in
            // _renderExitNodes — reusing a single instance across renders
            // crashed the shell because PopupMenuBase.removeAll() destroys
            // every menu item it contains, including this one.

            this._routesSeparator = new PopupMenu.PopupSeparatorMenuItem();
            this.menu.addMenuItem(this._routesSeparator);

            this._routesSubMenu = new PopupMenu.PopupSubMenuMenuItem(
                _('Tailnet routes'), true);
            this._routesPill = _decorateWithPill(this._routesSubMenu);
            this.menu.addMenuItem(this._routesSubMenu);

            this._funnelSeparator = new PopupMenu.PopupSeparatorMenuItem();
            this.menu.addMenuItem(this._funnelSeparator);

            this._funnelSubMenu = new PopupMenu.PopupSubMenuMenuItem(
                _('Funnel'), true);
            this._funnelPill = _decorateWithPill(this._funnelSubMenu);
            this.menu.addMenuItem(this._funnelSubMenu);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this.menu.addAction(_('Refresh'), () => this._client.refresh());

            // Paired action row: Extension settings | Admin panel. We can't
            // use addAction twice and stay on one line, so build a single
            // PopupBaseMenuItem with two horizontal St.Buttons inside.
            this._bottomRow = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: 'tailscale-bottom-row',
            });
            const buttonBox = new St.BoxLayout({
                x_expand: true,
                style_class: 'tailscale-bottom-buttons',
            });
            this._bottomRow.add_child(buttonBox);

            const settingsBtn = new St.Button({
                label: _('Extension settings'),
                x_expand: true,
                style_class: 'button',
            });
            settingsBtn.connect('clicked', () => {
                this.menu.close();
                this._extension.openPreferences();
            });
            buttonBox.add_child(settingsBtn);

            const adminBtn = new St.Button({
                label: _('Admin panel'),
                x_expand: true,
                style_class: 'button',
            });
            adminBtn.connect('clicked', () => {
                this.menu.close();
                _openAdminPanel();
            });
            buttonBox.add_child(adminBtn);

            this.menu.addMenuItem(this._bottomRow);

            // settings-actions registry hook used by gnome-shell's session
            // mode (hides settings entries on the lock screen). We register
            // the settings button itself, not a menu item.
            settingsBtn.visible = Main.sessionMode.allowSettings;
            this.menu._settingsActions = this.menu._settingsActions ?? {};
            this.menu._settingsActions[this._extension.uuid] = settingsBtn;
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

            // Toggle visual state: snap to daemon truth (auto-revert on
            // failed user clicks).
            this.checked = snap.running;
            this.gicon = _gicon(this._extension, snap.running ? ICON_ACTIVE : ICON_DISABLED);

            // Subtitle. When hidden, also recenter the title actor: QuickToggle
            // uses two stacked St.Labels (title above, subtitle below) inside
            // a vertical-centered box, but the title's own y_align stays START.
            // With the subtitle hidden, that leaves the title sitting where
            // it used to be (top of the slot). Switching the title to CENTER
            // makes it move into the now-vacant slot.
            const subtitle = this._statusText(snap);
            this.subtitle = showSub ? subtitle : '';
            if (this._title?.set_y_align) {
                this._title.set_y_align(showSub
                    ? Clutter.ActorAlign.START
                    : Clutter.ActorAlign.CENTER);
            }

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
            this._ipRow.setAccessory(snap.selfIps?.[0] ?? '-');
            this._ipRow.setOnline(snap.running);

            // Submenus + toggles.
            this._renderAccounts(snap);
            this._renderPeers(snap);
            this._renderExitNodes(snap);
            this._renderRoutes(snap);
            this._renderFunnels(snap);

            const sensitive = !!snap.canControl;
            for (const r of [this._acceptDNSRow, this._acceptRoutesRow,
                this._shieldsUpRow, this._runSSHRow])
                r.setSensitive(sensitive);

            this._acceptDNSRow.setChecked(snap.acceptDNS);
            this._acceptDNSRow.setAccessory(snap.magicDNSSuffix || '');

            this._acceptRoutesRow.setChecked(snap.acceptRoutes);
            this._acceptRoutesRow.setAccessory(this._routesAccessory(snap));

            this._shieldsUpRow.setChecked(snap.shieldsUp);
            this._runSSHRow.setChecked(snap.runSSH);
        }

        _routesAccessory(snap) {
            const n = snap.advertisedRoutes.length;
            if (n === 0) return '';
            return n === 1 ? _('1 advertised') : _fmt(_('%d advertised'), n);
        }

        _renderFunnels(snap) {
            const sub = this._funnelSubMenu.menu;
            sub.removeAll();
            const funnels = snap.funnels || [];
            const visible = funnels.length > 0;
            this._funnelSubMenu.visible = visible;
            this._funnelSeparator.visible = visible;
            this._funnelPill.text = String(funnels.length);
            this._funnelPill.visible = visible;
            if (!visible) return;

            this._funnelSubMenu.label.text = _('Funnel');

            for (const f of funnels) {
                const url = `https://${f.host}${f.httpsPort === 443 ? '' : `:${f.httpsPort}`}`;
                const row = new PeerRow({
                    title: url,
                    subtitle: f.target ? _fmt(_('proxies %s'), f.target) : '',
                    onClick: () => this._copyToClipboard(url),
                });
                sub.addMenuItem(row);
            }

            sub.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            sub.addAction(_('Manage funnels…'), () => this._extension.openPreferences());
        }

        _renderRoutes(snap) {
            const sub = this._routesSubMenu.menu;
            sub.removeAll();
            const n = snap.advertisedRoutes.length;

            // Show the "Tailnet routes" submenu only when Accept routes is ON
            // AND at least one peer advertises a route. Otherwise the section
            // (and its separator) take no space.
            const visible = snap.acceptRoutes && n > 0;
            this._routesSubMenu.visible = visible;
            this._routesSeparator.visible = visible;
            this._routesPill.text = String(n);
            this._routesPill.visible = visible;
            if (!visible) return;

            this._routesSubMenu.label.text = _('Tailnet routes');

            for (const route of snap.advertisedRoutes) {
                const row = new PeerRow({
                    title: route.cidr,
                    subtitle: route.peer ? _fmt(_('via %s'), route.peer) : '',
                });
                row.reactive = false;     // read-only listing
                sub.addMenuItem(row);
            }
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
            this._exitNodeSubMenu.label.text = _('Exit node');

            // Pill: current selection summary. Hidden when none is active.
            let pill = '';
            if (current) pill = current.hostname || current.dnsName;
            else if (snap.exitNodeID === 'auto:any') pill = _('auto');
            this._exitNodePill.text = pill;
            this._exitNodePill.visible = !!pill;

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
                const empty = new InfoRow(_('No approved exit nodes'));
                empty.reactive = false;
                sub.addMenuItem(empty);
            } else {
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

            // Allow LAN access only matters when an exit node is active. Build
            // a fresh ToggleRow every render: PopupMenuBase.removeAll() above
            // destroys every existing menu item, so a long-lived field on the
            // toggle would hand us a disposed actor on the next click and
            // crash gnome-shell.
            if (snap.exitNodeID) {
                sub.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                const lanRow = new ToggleRow(_('Allow LAN access'),
                    (v) => this._client.setAllowLanAccess(v));
                lanRow.setChecked(snap.allowLanAccess);
                lanRow.setSensitive(!!snap.canControl);
                sub.addMenuItem(lanRow);
            }
        }

        _renderPeers(snap) {
            const sub = this._peersSubMenu.menu;
            sub.removeAll();

            const total  = snap.peers.length;
            const online = snap.peers.filter((p) => p.online).length;
            this._peersSubMenu.label.text = _('Peers');
            this._peersPill.text = total ? `${online}/${total}` : '';
            this._peersPill.visible = total > 0;

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

            // Prefer the tailnet column (almost always the email) over the
            // account column, which can be a tagged-machine FQDN like
            // `yoga-diskmth.hair-acoustic.ts.net` for accounts that logged in
            // as a machine identity. The user wants the email everywhere.
            const accountTitle = (a) => a.tailnet || a.account || '';
            const accountSubtitle = (a) =>
                a.account && a.account !== a.tailnet ? a.account : '';

            const currentFromList = snap.accounts.find((a) => a.current);
            const currentLabel =
                accountTitle(currentFromList || {}) ||
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
                    const hint = new InfoRow(_('Operator not set: switching disabled'));
                    hint.reactive = false;
                    sub.addMenuItem(hint);
                }
            } else {
                for (const acc of snap.accounts) {
                    sub.addMenuItem(new PeerRow({
                        title: accountTitle(acc),
                        subtitle: accountSubtitle(acc),
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
