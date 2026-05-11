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
// the title label and the dropdown arrow. Returns the pill so callers can
// update it later.
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

// Checkmark-style toggle row. Override activate() so clicking does NOT emit
// 'activate' and therefore does NOT close the parent QuickSettings panel.
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

// Non-closing action row. Like menu.addAction() but activate() never emits
// the 'activate' signal, so clicking does not close the QuickSettings panel.
const ActionRow = GObject.registerClass(
    class ActionRow extends PopupMenu.PopupBaseMenuItem {
        _init(text, onActivate) {
            super._init();
            this._onActivate = onActivate;
            this.add_child(new St.Label({ text, x_expand: true, y_align: Clutter.ActorAlign.CENTER }));
        }
        activate(_event) {
            this._onActivate?.();
        }
    },
);

// Hybrid toggle + read-only submenu for "Accept routes". Clicking the label
// area toggles the accept-routes pref (no menu close). Clicking the triangle
// independently opens/closes the submenu showing the route list.
const RoutesSubToggle = GObject.registerClass(
    class RoutesSubToggle extends PopupMenu.PopupSubMenuMenuItem {
        _init(onToggle) {
            super._init(_('Accept routes'), false);
            this._onToggle = onToggle;
            this._checked = false;
            this.label.x_expand = true;
            this.label.y_align = Clutter.ActorAlign.CENTER;
            this.setOrnament(PopupMenu.Ornament.NONE);

            // Pill between label and triangle (same pattern as _decorateWithPill).
            this._pill = new St.Label({
                style_class: 'tailscale-status-pill',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._pill.visible = false;
            if (this._triangleBin)
                this.insert_child_below(this._pill, this._triangleBin);
            else
                this.add_child(this._pill);

            // Make the triangle bin intercept clicks independently so clicking
            // the triangle opens the submenu while clicking the label area
            // toggles the setting.
            if (this._triangleBin) {
                this._triangleBin.reactive = true;
                this._triangleBin.track_hover = true;
                this._triangleBin.connect('button-press-event', (_a, _e) => {
                    this.menu.toggle();
                    return Clutter.EVENT_STOP;
                });
            }
        }

        // Toggle pref on click; no super.activate() → no 'activate' signal →
        // no menu close. The triangle handler above opens/closes the submenu.
        activate(_event) {
            this._onToggle?.(!this._checked);
        }

        setChecked(v) {
            this._checked = !!v;
            this.setOrnament(v ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }

        setSensitive(v) {
            this.reactive = !!v;
            this.can_focus = !!v;
            this.label.opacity = v ? 255 : 128;
            this._pill.opacity = v ? 230 : 128;
        }

        // Show or hide the triangle (= dropdown affordance). Hide when the
        // route list is empty so the item behaves like a plain ToggleRow.
        setHasRoutes(has) {
            if (this._triangleBin) this._triangleBin.visible = has;
        }

        setPill(text) {
            this._pill.text = text || '';
            this._pill.visible = !!text;
        }
    },
);

// Peer/account/exit-node row. Override activate() so clicking does NOT emit
// 'activate' and therefore does NOT close the parent QuickSettings panel.
const PeerRow = GObject.registerClass(
    class PeerRow extends PopupMenu.PopupBaseMenuItem {
        _init({ title, subtitle, online, checked, onClick, styleClass }) {
            super._init({ style_class: styleClass ?? '' });
            this._onClick = onClick;

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
        }

        activate(_event) {
            this._onClick?.();
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

            this.menu.setHeader(
                _gicon(extension, ICON_DISABLED),
                'Tailscale',
                _('Disconnected'),
            );

            this._buildMenu();
            this._render(this._client.snapshot);
            this._makeMenuScrollable();
        }

        /* --------------------------- menu skeleton ------------------------ */

        _buildMenu() {
            this._banner = new BannerRow();
            this._banner.visible = false;
            this.menu.addMenuItem(this._banner);

            this._ipRow = new InfoRow(_('IP'), '-');
            this.menu.addMenuItem(this._ipRow);

            this._accountsSubMenu = new PopupMenu.PopupSubMenuMenuItem(_('Account'), true);
            this.menu.addMenuItem(this._accountsSubMenu);

            this._sep1 = new PopupMenu.PopupSeparatorMenuItem();
            this.menu.addMenuItem(this._sep1);

            this._peersSubMenu = new PopupMenu.PopupSubMenuMenuItem(_('Peers'), true);
            this._peersPill = _decorateWithPill(this._peersSubMenu);
            this.menu.addMenuItem(this._peersSubMenu);

            this._exitNodeSubMenu = new PopupMenu.PopupSubMenuMenuItem(_('Exit node'), true);
            this._exitNodePill = _decorateWithPill(this._exitNodeSubMenu);
            this.menu.addMenuItem(this._exitNodeSubMenu);

            this._sep2 = new PopupMenu.PopupSeparatorMenuItem();
            this.menu.addMenuItem(this._sep2);

            // DNS first (more commonly toggled than routes).
            this._acceptDNSRow = new ToggleRow(_('Accept DNS'),
                (v) => this._client.setAcceptDNS(v));
            this.menu.addMenuItem(this._acceptDNSRow);

            // Combined toggle + read-only submenu for routes.
            this._routesToggle = new RoutesSubToggle((v) => this._client.setAcceptRoutes(v));
            this.menu.addMenuItem(this._routesToggle);

            this._shieldsUpRow = new ToggleRow(_('Shields up'),
                (v) => this._client.setShieldsUp(v));
            this.menu.addMenuItem(this._shieldsUpRow);

            this._runSSHRow = new ToggleRow(_('Run SSH server'),
                (v) => this._client.setRunSSH(v));
            this.menu.addMenuItem(this._runSSHRow);

            this._funnelSeparator = new PopupMenu.PopupSeparatorMenuItem();
            this.menu.addMenuItem(this._funnelSeparator);

            this._funnelSubMenu = new PopupMenu.PopupSubMenuMenuItem(_('Funnel'), true);
            this._funnelPill = _decorateWithPill(this._funnelSubMenu);
            this.menu.addMenuItem(this._funnelSubMenu);

            this._sep3 = new PopupMenu.PopupSeparatorMenuItem();
            this.menu.addMenuItem(this._sep3);

            this._refreshRow = new ActionRow(_('Refresh'), () => this._client.refresh());
            this.menu.addMenuItem(this._refreshRow);

            // Paired action row: Extension settings | Admin panel on one line.
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

            this._adminBtn = new St.Button({
                label: _('Admin panel'),
                x_expand: true,
                style_class: 'button',
            });
            this._adminBtn.connect('clicked', () => {
                this.menu.close();
                _openAdminPanel();
            });
            buttonBox.add_child(this._adminBtn);

            this.menu.addMenuItem(this._bottomRow);

            settingsBtn.visible = Main.sessionMode.allowSettings;
            this.menu._settingsActions = this.menu._settingsActions ?? {};
            this.menu._settingsActions[this._extension.uuid] = settingsBtn;

            // All items that are hidden when the operator is not set.
            this._mainItems = [
                this._ipRow,
                this._accountsSubMenu,
                this._sep1,
                this._peersSubMenu,
                this._exitNodeSubMenu,
                this._sep2,
                this._acceptDNSRow,
                this._routesToggle,
                this._shieldsUpRow,
                this._runSSHRow,
                this._funnelSeparator,
                this._funnelSubMenu,
                this._sep3,
                this._refreshRow,
            ];
        }

        /* --------------------- scrollable menu wrapper -------------------- */

        // Wrap this.menu.box in a St.ScrollView so the menu can scroll when
        // submenus (peers, exit nodes) push it past the screen height.
        // The max-height is computed from the primary monitor so the constraint
        // is meaningful on any screen size.
        _makeMenuScrollable() {
            const box = this.menu.box;
            const parent = box.get_parent();
            if (!parent) return;

            const monitor = Main.layoutManager.primaryMonitor;
            const panelH  = Main.panel?.height ?? 32;
            const maxH    = monitor
                ? Math.floor((monitor.height - panelH * 2) * 0.85)
                : 650;

            const sv = new St.ScrollView({
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                clip_to_allocation: true,
                overlay_scrollbars: true,
                style: `max-height: ${maxH}px;`,
            });
            parent.remove_child(box);
            sv.set_child(box);
            parent.add_child(sv);
        }

        /* ----------------------------- actions ---------------------------- */

        _onUserClick() {
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

            this.checked = snap.running;
            this.gicon = _gicon(this._extension, snap.running ? ICON_ACTIVE : ICON_DISABLED);

            const subtitle = this._statusText(snap);
            this.subtitle = subtitle;

            this.menu.setHeader(
                _gicon(this._extension, snap.running ? ICON_ACTIVE : ICON_DISABLED),
                'Tailscale',
                snap.hostname ? `${snap.hostname} • ${subtitle}` : subtitle,
            );

            // Operator gate: when control is denied, show only the banner and
            // the Extension Settings button. Hide everything else so the menu
            // stays minimal and unambiguous.
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
                for (const item of this._mainItems) item.visible = false;
                this._adminBtn.visible = false;
                return;
            }

            this._banner.visible = false;
            this._adminBtn.visible = true;
            for (const item of this._mainItems) item.visible = true;

            this._ipRow.setText(_('IP'));
            this._ipRow.setAccessory(snap.selfIps?.[0] ?? '-');
            this._ipRow.setOnline(snap.running);

            this._renderAccounts(snap);
            this._renderPeers(snap);
            this._renderExitNodes(snap);
            this._renderRoutes(snap);
            this._renderFunnels(snap);

            const sensitive = !!snap.canControl;
            for (const r of [this._acceptDNSRow, this._routesToggle,
                this._shieldsUpRow, this._runSSHRow])
                r.setSensitive(sensitive);

            this._acceptDNSRow.setChecked(snap.acceptDNS);
            this._acceptDNSRow.setAccessory(snap.magicDNSSuffix || '');

            this._shieldsUpRow.setChecked(snap.shieldsUp);
            this._runSSHRow.setChecked(snap.runSSH);
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
            sub.addMenuItem(new ActionRow(_('Manage funnels…'), () => this._extension.openPreferences()));
        }

        _renderRoutes(snap) {
            const sub = this._routesToggle.menu;
            sub.removeAll();

            const routes = snap.advertisedRoutes;
            const n = routes.length;
            const hasRoutes = n > 0;

            this._routesToggle.setChecked(snap.acceptRoutes);
            this._routesToggle.setSensitive(!!snap.canControl);
            this._routesToggle.setHasRoutes(hasRoutes);

            if (hasRoutes) {
                const pillText = n === 1 ? _('1 route') : _fmt(_('%d routes'), n);
                this._routesToggle.setPill(pillText);
                for (const route of routes) {
                    const row = new PeerRow({
                        title: route.cidr,
                        subtitle: route.peer ? _fmt(_('via %s'), route.peer) : '',
                    });
                    row.reactive = false;
                    sub.addMenuItem(row);
                }
            } else {
                this._routesToggle.setPill('');
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

            this._exitNodeSubMenu.label.text = _('Exit node');

            // Pill is always visible. Shows what is currently selected.
            // auto:any may appear as the ExitNodeID magic string (older Tailscale)
            // or as a resolved peer ID with AutoExitNode=true (newer). Use the
            // normalised snap.autoExitNode flag for both cases.
            const isAuto = snap.autoExitNode;
            let pill;
            if (isAuto) {
                const name = snap.currentExitNode?.hostname ||
                    (snap.currentExitNode?.dnsName
                        ? snap.currentExitNode.dnsName.split('.')[0]
                        : '');
                pill = name ? `Auto (${name})` : _('Auto');
            } else if (snap.currentExitNode) {
                pill = snap.currentExitNode.hostname || snap.currentExitNode.dnsName;
            } else {
                pill = _('None');
            }
            this._exitNodePill.text = pill;
            this._exitNodePill.visible = true;

            sub.addMenuItem(new PeerRow({
                title: _('None'),
                checked: !snap.exitNodeID && !isAuto,
                onClick: () => this._client.setExitNode(''),
            }));
            sub.addMenuItem(new PeerRow({
                title: _('Automatic'),
                checked: isAuto,
                onClick: () => this._client.setExitNode('auto:any'),
            }));

            if (snap.exitNodes.length === 0) {
                const empty = new InfoRow(_('No approved exit nodes'));
                empty.reactive = false;
                sub.addMenuItem(empty);
            } else {
                sub.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                for (const peer of snap.exitNodes) {
                    // Use the Tailscale IP for --exit-node: hostnames can contain
                    // spaces which the CLI rejects as "invalid value".
                    const target = peer.ips[0] || peer.dnsName;
                    sub.addMenuItem(new PeerRow({
                        title: peer.hostname || peer.dnsName,
                        subtitle: peer.ips[0] ?? '',
                        online: peer.online,
                        checked: peer.exitNode,
                        styleClass: peer.exitNode ? 'tailscale-exit-node-active' : '',
                        onClick: () => this._client.setExitNode(target),
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

            const accountTitle    = (a) => a.tailnet || a.account || '';
            const accountSubtitle = (a) =>
                a.account && a.account !== a.tailnet ? a.account : '';

            const currentFromList = snap.accounts.find((a) => a.current);
            const currentLabel =
                accountTitle(currentFromList || {}) ||
                snap.accountName ||
                _('No account');
            this._accountsSubMenu.label.text = _fmt(_('Account: %s'), currentLabel);

            if (snap.accounts.length === 0) {
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
