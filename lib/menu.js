// QuickMenuToggle for Tailscale. The whole menu is rebuilt from the
// client's snapshot on every 'state-changed'. The body toggle uses
// toggleMode: true so `this.checked` flips synchronously on click; the
// next poll snaps it back if the action couldn't actually run.

import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as ModalDialog from "resource:///org/gnome/shell/ui/modalDialog.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
import * as QuickSettings from "resource:///org/gnome/shell/ui/quickSettings.js";

import { gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";

import { ToastManager } from "./toast.js";

const TAILSCALE_ADMIN_URL = "https://login.tailscale.com/admin/machines";

const ICON_ACTIVE = "tailscale-symbolic";
const ICON_DISABLED = "tailscale-disabled-symbolic";

function _gicon(extension, name) {
    return new Gio.FileIcon({
        file: extension.dir.get_child("icons").get_child(`${name}.svg`),
    });
}

// Decorate a PopupSubMenuMenuItem with a right-side pill, inserted between
// the title label and the dropdown arrow. Returns the pill so callers can
// update it later.
function _decorateWithPill(submenuItem) {
    submenuItem.label.x_expand = true;
    submenuItem.label.y_align = Clutter.ActorAlign.CENTER;
    const pill = new St.Label({
        style_class: "tailscale-status-pill",
        y_align: Clutter.ActorAlign.CENTER,
    });
    pill.visible = false;
    if (submenuItem._triangleBin)
        submenuItem.insert_child_below(pill, submenuItem._triangleBin);
    else submenuItem.add_child(pill);
    return pill;
}

function _openAdminPanel() {
    try {
        Gio.AppInfo.launch_default_for_uri(TAILSCALE_ADMIN_URL, null);
    } catch (e) {
        ToastManager.show({
            level: "error",
            message: `Could not open ${TAILSCALE_ADMIN_URL}`,
        });
    }
}

// Find a Mutter window that looks like our extension's prefs window and
// raise/focus it. openPreferences() handles the "spawn or single-instance
// activate" side, but on some setups the existing window stays buried under
// the shell; activating it explicitly with the current timestamp brings it
// reliably on top.
function _activatePrefsWindow(extension) {
    const name = extension.metadata?.name;
    if (!name) return false;
    const actors = global.get_window_actors?.() ?? [];
    for (const actor of actors) {
        const win = actor.meta_window;
        if (!win) continue;
        const title = win.get_title() || "";
        if (title === name || title.startsWith(`${name} `)) {
            win.activate(global.get_current_time());
            return true;
        }
    }
    return false;
}

function _fmt(template, ...args) {
    let i = 0;
    return template.replace(/%[sd]/g, () => {
        const v = args[i++];
        return v === undefined || v === null ? "" : String(v);
    });
}

// Run a subprocess and resolve with { ok, code, stdout, stderr }. Used for
// short-lived helpers (zenity dialogs). Never rejects.
function _spawnAsync(argv) {
    return new Promise((resolve) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            resolve({ ok: false, code: -1, stdout: "", stderr: String(e.message ?? e) });
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                resolve({
                    ok: p.get_successful(),
                    code: p.get_exit_status(),
                    stdout: stdout ?? "",
                    stderr: stderr ?? "",
                });
            } catch (e) {
                resolve({ ok: false, code: -1, stdout: "", stderr: String(e.message ?? e) });
            }
        });
    });
}

/* -------------------------------------------------------------------------- */
/*                              Helper widgets                                */
/* -------------------------------------------------------------------------- */

const InfoRow = GObject.registerClass(
    class InfoRow extends PopupMenu.PopupBaseMenuItem {
        _init(text, accessory = null, opts = {}) {
            super._init({
                reactive: false,
                style_class: opts.styleClass ?? "",
            });
            this._label = new St.Label({
                text,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this._label);
            this._accessory = null;
            if (accessory) this.setAccessory(accessory);
        }
        setText(t) {
            this._label.text = t;
        }
        setAccessory(t) {
            if (!this._accessory) {
                this._accessory = new St.Label({
                    style_class: "tailscale-status-pill",
                    y_align: Clutter.ActorAlign.CENTER,
                });
                this.add_child(this._accessory);
            }
            this._accessory.text = t;
        }
        setOnline(online) {
            if (!this._accessory) return;
            this._accessory.remove_style_class_name("online");
            this._accessory.remove_style_class_name("offline");
            this._accessory.add_style_class_name(online ? "online" : "offline");
        }

        addCopyButton(callback) {
            this.reactive = true;
            const btn = new St.Button({
                style_class: "button tailscale-icon-btn",
                child: new St.Icon({ icon_name: "edit-copy-symbolic", icon_size: 16 }),
                y_align: Clutter.ActorAlign.CENTER,
            });
            btn.connect("clicked", callback);
            this.add_child(btn);
            return btn;
        }

        activate(_event) {
            // No-op: clicking row body must not close the menu.
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
            this._title = new St.Label({ text: "" });
            this._sub = new St.Label({
                text: "",
                style_class: "tailscale-peer-ip",
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
            this.setOrnament(
                v ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE,
            );
        }
        setSensitive(v) {
            this.reactive = !!v;
            this.can_focus = !!v;
            this._label.opacity = v ? 255 : 128;
            if (this._accessory) this._accessory.opacity = v ? 230 : 128;
        }
        setAccessory(text) {
            if (!text) {
                if (this._accessory) this._accessory.text = "";
                return;
            }
            if (!this._accessory) {
                this._accessory = new St.Label({
                    style_class: "tailscale-status-pill",
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
            this.add_child(
                new St.Label({
                    text,
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            );
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
            super._init(_("Accept routes"), false);
            this._onToggle = onToggle;
            this._checked = false;
            this.label.x_expand = true;
            this.label.y_align = Clutter.ActorAlign.CENTER;
            this.setOrnament(PopupMenu.Ornament.NONE);

            // Pill between label and triangle (same pattern as _decorateWithPill).
            this._pill = new St.Label({
                style_class: "tailscale-status-pill",
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._pill.visible = false;
            if (this._triangleBin)
                this.insert_child_below(this._pill, this._triangleBin);
            else this.add_child(this._pill);

            // Make the triangle bin intercept clicks independently so clicking
            // the triangle opens the submenu while clicking the label area
            // toggles the setting.
            if (this._triangleBin) {
                this._triangleBin.reactive = true;
                this._triangleBin.track_hover = true;
                this._triangleBin.connect("button-press-event", (_a, _e) => {
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
            this.setOrnament(
                v ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE,
            );
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
            this._pill.text = text || "";
            this._pill.visible = !!text;
        }
    },
);

// Peer/account/exit-node row. Override activate() so clicking does NOT emit
// 'activate' and therefore does NOT close the parent QuickSettings panel.
const PeerRow = GObject.registerClass(
    class PeerRow extends PopupMenu.PopupBaseMenuItem {
        _init({ title, subtitle, online, checked, onClick, styleClass, onCopy }) {
            super._init({ style_class: styleClass ?? "" });
            this._onClick = onClick;

            const box = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            box.add_child(new St.Label({ text: title }));
            if (subtitle) {
                box.add_child(
                    new St.Label({
                        text: subtitle,
                        style_class: "tailscale-peer-ip",
                    }),
                );
            }
            this.add_child(box);

            if (online !== undefined) {
                this.add_child(
                    new St.Label({
                        text: online ? "●" : "○",
                        y_align: Clutter.ActorAlign.CENTER,
                        style: `color: ${online ? "#66d68a" : "#888"}; margin-left: 6px;`,
                    }),
                );
                if (!online)
                    this.add_style_class_name("tailscale-peer-offline");
            }

            if (onCopy) {
                const copyBtn = new St.Button({
                    style_class: "button tailscale-icon-btn",
                    child: new St.Icon({ icon_name: "edit-copy-symbolic", icon_size: 16 }),
                    y_align: Clutter.ActorAlign.CENTER,
                });
                copyBtn.connect("clicked", onCopy);
                this.add_child(copyBtn);
            }

            this.setOrnament(
                checked ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE,
            );
        }

        activate(_event) {
            this._onClick?.();
        }
    },
);

/* -------------------------------------------------------------------------- */
/*                           Taildrop send dialog                             */
/* -------------------------------------------------------------------------- */

// Reuses PeerRow visuals inside a ModalDialog. Same look as the quick-menu
// peer list so Nautilus and in-shell flows feel identical.
const SendFileDialog = GObject.registerClass(
    class SendFileDialog extends ModalDialog.ModalDialog {
        _init({ files, peers, onPick }) {
            super._init({ styleClass: "tailscale-send-dialog" });
            this._onPick = onPick;
            this._resolved = false;

            const title = new St.Label({
                style_class: "tailscale-send-title",
                text: _("Send via Taildrop"),
            });
            this.contentLayout.add_child(title);

            const summary = files.length === 1
                ? files[0].split("/").pop()
                : _fmt(_("%d files"), files.length);
            this.contentLayout.add_child(new St.Label({
                style_class: "tailscale-send-subtitle",
                text: summary,
            }));

            const scroll = new St.ScrollView({
                style_class: "tailscale-send-scroll",
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true,
            });
            const list = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: "tailscale-send-list",
            });
            scroll.set_child(list);
            this.contentLayout.add_child(scroll);

            for (let i = 0; i < peers.length; i++) {
                if (i > 0) {
                    list.add_child(new St.Widget({
                        style_class: "tailscale-send-separator",
                        height: 1,
                        x_expand: true,
                    }));
                }
                list.add_child(this._makeRow(peers[i]));
            }

            this.setButtons([
                {
                    label: _("Cancel"),
                    action: () => this._finish(null),
                    key: Clutter.KEY_Escape,
                },
            ]);
        }

        _makeRow(peer) {
            const btn = new St.Button({
                style_class: "tailscale-send-row",
                can_focus: true,
                x_expand: true,
                track_hover: true,
            });
            const row = new St.BoxLayout({
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            const text = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            text.add_child(new St.Label({ text: peer.host }));
            text.add_child(new St.Label({
                text: peer.ip,
                style_class: "tailscale-peer-ip",
            }));
            row.add_child(text);
            row.add_child(new St.Label({
                text: "●",
                y_align: Clutter.ActorAlign.CENTER,
                style: "color: #66d68a; margin-left: 6px;",
            }));
            btn.set_child(row);
            btn.connect("clicked", () => this._finish(peer));
            return btn;
        }

        _finish(peer) {
            if (this._resolved) return;
            this._resolved = true;
            this.close();
            this._onPick?.(peer);
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
                title: "Tailscale",
                subtitle: _("Loading…"),
                gicon: _gicon(extension, ICON_DISABLED),
                toggleMode: true,
            });

            this._extension = extension;
            this._client = client;
            this._settings = extension.getSettings();
            this._signalIds = [];
            this._settingsIds = [];

            this._signalIds.push(
                this.connect("clicked", () => this._onUserClick()),
            );

            // Mirror the Taildrop toggle in the menu when the same setting
            // is changed elsewhere (prefs dialog, dconf-editor, etc.).
            this._settingsIds.push(
                this._settings.connect("changed::taildrop-accept", () =>
                    this._render(this._client.snapshot)),
            );

            // Feature toggles (Features panel in prefs) AND the per-tailnet
            // availability cache. Re-render on either so newly enabled blocks
            // appear and admin-disabled ones disappear without waiting for
            // the next poll.
            for (const key of [
                "feature-exit-nodes",
                "feature-dns",
                "feature-routes",
                "feature-shields-up",
                "feature-ssh-server",
                "feature-taildrop",
                "feature-funnels",
                "feature-taildrop-available",
                "feature-funnels-available",
            ]) {
                this._settingsIds.push(
                    this._settings.connect(`changed::${key}`, () =>
                        this._render(this._client.snapshot)),
                );
            }

            // While a user-initiated op is in flight, _withFeedback owns the
            // toast and will publish the final state from the awaited result.
            // Signal-emitted feedback from the SAME op is suppressed to avoid
            // a duplicate toast; spontaneous emits (received files, daemon
            // errors) still surface as their own toast.
            this._activeOp = null;
            // Tracks the exit node state from the last render so spontaneous
            // changes (node offline, admin disable, auto-mode loss) trigger a
            // toast without waiting for the user to notice the pill changed.
            this._exitTrack = null;
            const spontaneous = (level, msg) => {
                if (this._activeOp) return;
                ToastManager.show({ level, message: msg });
            };

            this._signalIds.push(
                this._client.connect("state-changed", (_c, snap) =>
                    this._render(snap),
                ),
                this._client.connect("error", (_c, msg) =>
                    spontaneous("error", msg),
                ),
                this._client.connect("notify-info", (_c, msg) =>
                    spontaneous("success", msg),
                ),
            );

            this.menu.setHeader(
                _gicon(extension, ICON_DISABLED),
                "Tailscale",
                _("Disconnected"),
            );

            this._buildMenu();
            this._attachHeaderRefreshButton();
            this._render(this._client.snapshot);
        }

        // Inject a compact icon-button into the QuickToggleMenu header
        // (right of the title/subtitle box). The system header is a private
        // BoxLayout exposed as `this.menu._header` since GNOME 44; if a
        // future shell version renames it, we silently fall back to keeping
        // the old full-width Refresh row.
        _attachHeaderRefreshButton() {
            const header = this.menu._header;
            if (!header || typeof header.add_child !== "function") return;

            this._headerRefreshBtn = new St.Button({
                style_class: "tailscale-header-btn",
                child: new St.Icon({
                    icon_name: "rotation-allowed-symbolic",
                    icon_size: 16,
                }),
                y_align: Clutter.ActorAlign.CENTER,
                x_align: Clutter.ActorAlign.END,
                can_focus: true,
                track_hover: true,
                accessible_name: _("Refresh"),
            });
            this._headerRefreshBtn.connect("clicked", () => {
                this._client.refresh();
                ToastManager.show({
                    level: "success",
                    message: _("Status refreshed"),
                });
            });
            header.add_child(this._headerRefreshBtn);
        }

        /* --------------------------- menu skeleton ------------------------ */

        _buildMenu() {
            this._banner = new BannerRow();
            this._banner.visible = false;
            this.menu.addMenuItem(this._banner);

            // Operator-not-set row: label + one-click "Set operator" button
            // that runs `pkexec tailscale set --operator=$USER`. The user
            // gets a polkit password prompt instead of having to copy a
            // command into a terminal.
            this._operatorRow = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });
            const opBox = new St.BoxLayout({ x_expand: true });
            opBox.add_child(
                new St.Label({
                    text: _("Operator not set"),
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            );
            const opBtn = new St.Button({
                label: _("Set operator"),
                style_class: "button",
            });
            opBtn.connect("clicked", () => {
                this._withFeedback(
                    _("Granting operator privilege"),
                    _("Operator set"),
                    () => this._client.setOperator(),
                );
            });
            opBox.add_child(opBtn);
            this._operatorRow.add_child(opBox);
            this._operatorRow.visible = false;
            this.menu.addMenuItem(this._operatorRow);

            this._ipRow = new InfoRow(_("IP"), "-");
            this._ipCopyBtn = this._ipRow.addCopyButton(() => {
                if (this._selfIp) this._copyToClipboard(this._selfIp);
            });
            this._ipCopyBtn.visible = false;
            this.menu.addMenuItem(this._ipRow);

            this._accountsSubMenu = new PopupMenu.PopupSubMenuMenuItem(
                _("Account"),
                true,
            );
            this.menu.addMenuItem(this._accountsSubMenu);

            this._sep1 = new PopupMenu.PopupSeparatorMenuItem();
            this.menu.addMenuItem(this._sep1);

            this._peersSubMenu = new PopupMenu.PopupSubMenuMenuItem(
                _("Peers"),
                true,
            );
            this._peersPill = _decorateWithPill(this._peersSubMenu);
            this.menu.addMenuItem(this._peersSubMenu);

            this._exitNodeSubMenu = new PopupMenu.PopupSubMenuMenuItem(
                _("Exit node"),
                true,
            );
            // Warning glyph sits immediately before the pill — surfaces
            // "selected exit node unreachable" without forcing the user
            // to read the pill text. Hidden by default; flipped on in
            // _renderExitNodes when the daemon's pick can't route.
            this._exitNodeWarnIcon = new St.Icon({
                icon_name: "network-vpn-disconnected-symbolic",
                style_class: "tailscale-exit-warn-icon",
                icon_size: 14,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._exitNodeWarnIcon.visible = false;
            if (this._exitNodeSubMenu._triangleBin)
                this._exitNodeSubMenu.insert_child_below(
                    this._exitNodeWarnIcon,
                    this._exitNodeSubMenu._triangleBin,
                );
            else this._exitNodeSubMenu.add_child(this._exitNodeWarnIcon);
            this._exitNodePill = _decorateWithPill(this._exitNodeSubMenu);
            this.menu.addMenuItem(this._exitNodeSubMenu);

            this._sep2 = new PopupMenu.PopupSeparatorMenuItem();
            this.menu.addMenuItem(this._sep2);

            // DNS first (more commonly toggled than routes).
            this._acceptDNSRow = new ToggleRow(_("Magic DNS"), (v) =>
                this._withFeedback(
                    v ? _("Enabling Magic DNS") : _("Disabling Magic DNS"),
                    v ? _("Magic DNS: on") : _("Magic DNS: off"),
                    () => this._client.setAcceptDNS(v),
                ),
            );
            this.menu.addMenuItem(this._acceptDNSRow);

            // Combined toggle + read-only submenu for routes.
            this._routesToggle = new RoutesSubToggle((v) =>
                this._withFeedback(
                    v ? _("Enabling Accept routes") : _("Disabling Accept routes"),
                    v ? _("Accept routes: on") : _("Accept routes: off"),
                    () => this._client.setAcceptRoutes(v),
                ),
            );
            this.menu.addMenuItem(this._routesToggle);

            // Taildrop accept toggle sits right below Accept routes.
            this._acceptFilesRow = new ToggleRow(_("Accept files"),
                (v) => this._setAcceptFiles(v));
            this.menu.addMenuItem(this._acceptFilesRow);

            this._shieldsUpRow = new ToggleRow(_("Shields up"), (v) =>
                this._withFeedback(
                    v ? _("Enabling Shields up") : _("Disabling Shields up"),
                    v ? _("Shields up: on") : _("Shields up: off"),
                    () => this._client.setShieldsUp(v),
                ),
            );
            this.menu.addMenuItem(this._shieldsUpRow);

            this._runSSHRow = new ToggleRow(_("Run SSH server"), (v) =>
                this._withFeedback(
                    v ? _("Enabling SSH server") : _("Disabling SSH server"),
                    v ? _("SSH server: on") : _("SSH server: off"),
                    () => this._client.setRunSSH(v),
                ),
            );
            this.menu.addMenuItem(this._runSSHRow);

            // Single separator before the file-transfer / funnel block.
            this._funnelSeparator = new PopupMenu.PopupSeparatorMenuItem();
            this.menu.addMenuItem(this._funnelSeparator);

            this._sendFileRow = new ActionRow(_("Send file"),
                () => { this._closeAllMenus(); this._runSendFlow(); });
            this.menu.addMenuItem(this._sendFileRow);

            this._funnelSubMenu = new PopupMenu.PopupSubMenuMenuItem(
                _("Funnel"),
                true,
            );
            this._funnelPill = _decorateWithPill(this._funnelSubMenu);
            this.menu.addMenuItem(this._funnelSubMenu);

            this._sep3 = new PopupMenu.PopupSeparatorMenuItem();
            this.menu.addMenuItem(this._sep3);

            // Paired action row: Extension settings | Admin panel on one line.
            this._bottomRow = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: "tailscale-bottom-row",
            });
            const buttonBox = new St.BoxLayout({
                x_expand: true,
                style_class: "tailscale-bottom-buttons",
            });
            this._bottomRow.add_child(buttonBox);

            const settingsBtn = new St.Button({
                label: _("Extension settings"),
                x_expand: true,
                style_class: "button",
            });
            settingsBtn.connect("clicked", () => {
                // Close BOTH the toggle menu and the parent QuickSettings
                // panel before opening prefs so the new window receives
                // focus instead of the shell stealing it back. Then
                // explicitly raise an already-open prefs window with the
                // current event timestamp.
                const id = this.menu.connect("open-state-changed", (_m, isOpen) => {
                    if (isOpen) return;
                    this.menu.disconnect(id);
                    this._extension.openPreferences();
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
                        _activatePrefsWindow(this._extension);
                        return GLib.SOURCE_REMOVE;
                    });
                });
                this._closeAllMenus();
            });
            buttonBox.add_child(settingsBtn);

            this._adminBtn = new St.Button({
                label: _("Admin panel"),
                x_expand: true,
                style_class: "button",
            });
            this._adminBtn.connect("clicked", () => {
                this._closeAllMenus();
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
                this._acceptFilesRow,
                this._shieldsUpRow,
                this._runSSHRow,
                this._funnelSeparator,
                this._sendFileRow,
                this._funnelSubMenu,
                this._sep3,
            ];
        }

        /* ----------------------------- actions ---------------------------- */

        _onUserClick() {
            const snap = this._client.snapshot;
            // On/off only makes sense once we have BOTH an operator (canControl)
            // AND an authenticated account. Without the operator, every CLI
            // call would hit "access denied"; without an account, "up" would
            // trigger an unwanted login flow that wipes prefs. Revert the
            // toggle visual and steer the user toward the right action.
            const ready =
                snap.canControl &&
                !snap.loggedOut &&
                snap.backendState !== "NeedsLogin" &&
                snap.backendState !== "NoState";
            if (!ready) {
                this.checked = !!snap.running;
                if (!snap.canControl) {
                    // Operator missing → fire pkexec prompt directly so the
                    // user doesn't have to dig into the menu to find the
                    // "Set operator" button.
                    this._client.setOperator();
                } else {
                    ToastManager.show({
                        level: "info",
                        message: _("Login required (see Account menu)"),
                    });
                    this.menu.open();
                }
                return;
            }
            if (this.checked) {
                this._withFeedback(
                    _("Connecting Tailscale"),
                    _("Tailscale connected"),
                    () => this._client.up(),
                );
            } else {
                this._withFeedback(
                    _("Disconnecting Tailscale"),
                    _("Tailscale disconnected"),
                    () => this._client.down(),
                );
            }
        }

        /* ------------------------------ render ---------------------------- */

        // Surface spontaneous exit-node changes (offline, admin disable,
        // auto-mode pick changed) as toasts. Skipped when a user-initiated
        // op is in flight — _withFeedback owns the toast in that case.
        //
        // A node only counts as "effective" when actually routable
        // (online AND still advertising as an exit). The daemon does not
        // clear `ExitNode: true` when its picked node goes offline, so a
        // raw ID compare would miss the offline transition: the pill
        // shows "Auto (None)" but no toast would fire. Aligning the
        // tracker with the pill's "routable" rule fixes Auto-mode
        // switches and unroutable transitions both.
        _maybeToastExitNodeChange(snap) {
            if (this._activeOp) return;
            const t = this._exitTrack;
            if (!t) return;

            const tsIcon = ToastManager.tailscaleIcon;
            const nameOf = (n) =>
                n?.hostname || n?.dnsName?.split(".")[0] || _("Exit node");
            const show = (level, message) =>
                ToastManager.show({ level, message, gicon: tsIcon });

            const effId = (node) =>
                node && node.online && node.exitNodeOption ? node.id : null;
            const currNode = snap.currentExitNode;
            const currEff = effId(currNode);

            if (t.autoExitNode && snap.autoExitNode) {
                const prevEff = t.effectiveNodeId;
                if (prevEff && !currEff)
                    show("warning", _("Auto exit node lost"));
                else if (!prevEff && currEff)
                    show("info", _fmt(_("Auto exit node: %s"), nameOf(currNode)));
                else if (prevEff && currEff && prevEff !== currEff)
                    show("info", _fmt(_("Auto exit node switched to %s"), nameOf(currNode)));
            } else if (!t.autoExitNode && !snap.autoExitNode &&
                       t.exitNodeID && t.exitNodeID === snap.exitNodeID) {
                if (t.nodeOnline !== null && currNode) {
                    if (t.nodeOnline && !currNode.online)
                        show("warning", _fmt(_("Exit node %s went offline"), nameOf(currNode)));
                    else if (!t.nodeOnline && currNode.online)
                        show("info", _fmt(_("Exit node %s is back online"), nameOf(currNode)));
                }
                if (t.nodeOption !== null && currNode) {
                    if (t.nodeOption && !currNode.exitNodeOption)
                        show("warning", _fmt(_("Exit node %s was disabled"), nameOf(currNode)));
                    else if (!t.nodeOption && currNode.exitNodeOption)
                        show("info", _fmt(_("Exit node %s was re-enabled"), nameOf(currNode)));
                }
            }
        }

        _render(snap) {
            if (!snap) return;

            this._maybeToastExitNodeChange(snap);
            const curr = snap.currentExitNode;
            this._exitTrack = {
                exitNodeID: snap.exitNodeID,
                autoExitNode: snap.autoExitNode,
                effectiveNodeId:
                    curr && curr.online && curr.exitNodeOption
                        ? curr.id
                        : null,
                nodeOnline: curr?.online ?? null,
                nodeOption: curr?.exitNodeOption ?? null,
            };

            this.checked = snap.running;
            this.gicon = _gicon(
                this._extension,
                snap.running ? ICON_ACTIVE : ICON_DISABLED,
            );

            const subtitle = this._statusText(snap);
            this.subtitle = subtitle;

            this.menu.setHeader(
                _gicon(
                    this._extension,
                    snap.running ? ICON_ACTIVE : ICON_DISABLED,
                ),
                "Tailscale",
                snap.hostname ? `${snap.hostname} • ${subtitle}` : subtitle,
            );

            // Operator gate: when control is denied, show only the operator row
            // and the Extension Settings button. Hide everything else.
            if (!snap.canControl) {
                this._operatorRow.visible = true;
                this._banner.visible = false;
                for (const item of this._mainItems) item.visible = false;
                this._adminBtn.visible = false;
                return;
            }

            this._operatorRow.visible = false;
            this._banner.visible = false;
            this._adminBtn.visible = true;

            // No active account: show only the accounts submenu (for login).
            // Hide all network settings -they require an authenticated session.
            if (snap.loggedOut || snap.backendState === "NeedsLogin") {
                for (const item of this._mainItems)
                    item.visible = item === this._accountsSubMenu;
                this._renderAccounts(snap);
                return;
            }

            for (const item of this._mainItems) item.visible = true;

            this._selfIp = snap.selfIps?.[0] ?? "";
            this._ipRow.setText(_("IP"));
            this._ipRow.setAccessory(this._selfIp || "-");
            this._ipRow.setOnline(snap.running);
            if (this._ipCopyBtn) this._ipCopyBtn.visible = !!this._selfIp;

            this._renderAccounts(snap);
            this._renderPeers(snap);
            this._renderExitNodes(snap);
            this._renderRoutes(snap);
            this._renderFunnels(snap);

            // Apply gates last: _renderFunnels resets the submenu/separator
            // visibility unconditionally, so the gate must have the final word.
            this._applyFeatureGates();

            const sensitive = !!snap.canControl;
            for (const r of [
                this._acceptDNSRow,
                this._routesToggle,
                this._shieldsUpRow,
                this._runSSHRow,
                this._acceptFilesRow,
            ])
                r.setSensitive(sensitive);

            this._acceptDNSRow.setChecked(snap.acceptDNS);
            this._acceptDNSRow.setAccessory(snap.magicDNSSuffix || "");

            this._shieldsUpRow.setChecked(snap.shieldsUp);
            this._runSSHRow.setChecked(snap.runSSH);

            // Taildrop toggle reflects the dconf setting (the receiver
            // process state is derived from it, not the other way around).
            this._acceptFilesRow.setChecked(
                this._settings.get_boolean("taildrop-accept"),
            );
        }

        _renderFunnels(snap) {
            const sub = this._funnelSubMenu.menu;
            sub.removeAll();
            const funnels = snap.funnels || [];

            this._funnelSubMenu.visible = true;
            this._funnelSeparator.visible = true;
            this._funnelPill.text = funnels.length > 0 ? String(funnels.length) : "";
            this._funnelPill.visible = funnels.length > 0;

            if (funnels.length === 0) {
                const empty = new InfoRow(_("No funnels configured"));
                empty.reactive = false;
                sub.addMenuItem(empty);
            } else {
                for (const f of funnels) {
                    const url = `https://${f.host}${f.httpsPort === 443 ? "" : `:${f.httpsPort}`}`;
                    sub.addMenuItem(this._makeFunnelRow(f, url));
                }
            }

            sub.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            sub.addMenuItem(new ActionRow(_("Add funnel"),
                () => { this._closeAllMenus(); this._runAddFunnelFlow(); }));
        }

        _makeFunnelRow(f, url) {
            const row = new PopupMenu.PopupBaseMenuItem({
                style_class: "tailscale-funnel-row",
            });
            const box = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            box.add_child(new St.Label({ text: url }));
            if (f.target) {
                box.add_child(new St.Label({
                    text: _fmt(_("proxies %s"), f.target),
                    style_class: "tailscale-peer-ip",
                }));
            }
            row.add_child(box);

            const copyBtn = new St.Button({
                style_class: "button tailscale-icon-btn",
                child: new St.Icon({ icon_name: "edit-copy-symbolic", icon_size: 16 }),
                y_align: Clutter.ActorAlign.CENTER,
            });
            copyBtn.connect("clicked", () => this._copyToClipboard(url));
            row.add_child(copyBtn);

            const removeBtn = new St.Button({
                style_class: "button tailscale-icon-btn",
                child: new St.Icon({ icon_name: "user-trash-symbolic", icon_size: 16 }),
                y_align: Clutter.ActorAlign.CENTER,
            });
            // Match the "Add funnel" toast wording: show the local target port
            // (what the user actually proxied), not the public httpsPort which
            // is almost always 443 and uninformative.
            const localPortMatch = (f.target || "").match(/:(\d+)(?:[^\d]|$)/);
            const displayPort = localPortMatch
                ? parseInt(localPortMatch[1], 10) : f.httpsPort;
            removeBtn.connect("clicked", () => this._withFeedback(
                _fmt(_("Removing funnel on port %d"), displayPort),
                _fmt(_("Funnel removed on port %d"), displayPort),
                () => this._client.removeFunnel(f.httpsPort),
            ));
            row.add_child(removeBtn);

            // Activate (click on the label area) copies the URL too -quick
            // affordance without having to aim at the small icon button.
            row.activate = () => this._copyToClipboard(url);
            return row;
        }

        async _runAddFunnelFlow() {
            const portRes = await _spawnAsync([
                "zenity", "--entry",
                "--title=Add funnel",
                "--text=Local port to expose:",
                "--entry-text=3000",
            ]);
            if (!portRes.ok || !portRes.stdout.trim()) return;
            const port = parseInt(portRes.stdout.trim(), 10);
            if (isNaN(port) || port < 1 || port > 65535) {
                ToastManager.show({
                    level: "error",
                    message: _("Invalid port number"),
                });
                return;
            }
            // addFunnel may return notEnabled (browser approval needed) — in
            // that case _withFeedback's "success" branch ends up wrong, so we
            // peek the result and override the toast with an info message.
            let openedApproval = null;
            const r = await this._withFeedback(
                _fmt(_("Adding funnel on port %d"), port),
                _fmt(_("Funnel added on port %d"), port),
                async () => {
                    const res = await this._client.addFunnel(port);
                    if (res.notEnabled) {
                        openedApproval = res.url;
                        // Treat as a success-ish outcome (no error) so the
                        // toast doesn't go red; we re-message it just below.
                        return { ok: true, message: '' };
                    }
                    return res;
                },
            );
            if (openedApproval) {
                try { Gio.AppInfo.launch_default_for_uri(openedApproval, null); } catch (_) {}
                ToastManager.show({
                    level: "info",
                    message: _("Approve Funnel in the browser, then retry."),
                });
            }
            return r;
        }

        _renderRoutes(snap) {
            const sub = this._routesToggle.menu;
            sub.removeAll();

            // Split off the catch-all routes that an active exit node injects
            // (0.0.0.0/0, ::/0). They aren't subnet routes the user actively
            // accepted via --accept-routes — they ride on the exit-node
            // selection — so listing them inline with real subnets is
            // misleading. Show them under a separate header instead.
            const isDefault = (cidr) => cidr === "0.0.0.0/0" || cidr === "::/0";
            const subnetRoutes = snap.advertisedRoutes.filter(
                (r) => !isDefault(r.cidr),
            );
            const exitDefaults = snap.advertisedRoutes.filter(
                (r) => isDefault(r.cidr),
            );
            const hasAny = subnetRoutes.length + exitDefaults.length > 0;

            this._routesToggle.setChecked(snap.acceptRoutes);
            this._routesToggle.setSensitive(!!snap.canControl);
            this._routesToggle.setHasRoutes(hasAny);

            // Pill counts only meaningful subnet routes — the catch-alls are
            // intentionally excluded.
            if (subnetRoutes.length > 0) {
                this._routesToggle.setPill(
                    subnetRoutes.length === 1
                        ? _("1 route")
                        : _fmt(_("%d routes"), subnetRoutes.length),
                );
            } else {
                this._routesToggle.setPill("");
            }

            const addPeerRow = (route) => {
                const row = new PeerRow({
                    title: route.cidr,
                    subtitle: route.peer ? _fmt(_("via %s"), route.peer) : "",
                });
                row.reactive = false;
                sub.addMenuItem(row);
            };

            for (const route of subnetRoutes) addPeerRow(route);

            if (exitDefaults.length > 0) {
                if (subnetRoutes.length > 0)
                    sub.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                const header = new PopupMenu.PopupBaseMenuItem({
                    reactive: false,
                    can_focus: false,
                });
                header.add_child(new St.Label({
                    text: _("Through exit node"),
                    style_class: "tailscale-peer-ip",
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                }));
                sub.addMenuItem(header);
                for (const route of exitDefaults) addPeerRow(route);
            }
        }

        _statusText(snap) {
            if (snap.error) return _("Tailscale unavailable");
            if (snap.loggedOut) return _("Logged out");
            if (snap.backendState === "NeedsLogin") return _("Login required");
            if (snap.running) return snap.accountName || _("Connected");
            return _("Disconnected");
        }

        _renderExitNodes(snap) {
            const sub = this._exitNodeSubMenu.menu;
            sub.removeAll();

            this._exitNodeSubMenu.label.text = _("Exit node");

            const isAuto = snap.autoExitNode;
            const node = snap.currentExitNode;
            const nameOf = (n) => n.hostname || n.dnsName?.split(".")[0] || "";

            // Pill reflects the EFFECTIVE routing state, not just the
            // pref. Three failure modes to surface:
            //   - peer offline (unreachable from the tailnet)
            //   - peer online but stopped advertising itself as exit node
            //   - in auto mode, both of the above
            let pill;
            if (isAuto) {
                if (node && node.online && node.exitNodeOption)
                    pill = _fmt(_("Auto (%s)"), nameOf(node));
                else pill = _("Auto (None)");
            } else if (node) {
                const name = nameOf(node);
                if (!node.online) pill = _fmt(_("Offline (%s)"), name);
                else if (!node.exitNodeOption)
                    pill = _fmt(_("Disabled (%s)"), name);
                else pill = name;
            } else {
                pill = _("None");
            }
            this._exitNodePill.text = pill;
            this._exitNodePill.visible = true;

            // Warning glyph: user wants an exit node (Auto or Direct)
            // but the daemon's pick can't route — same condition the
            // top-bar warning indicator uses, kept in sync here.
            const wantsExit = !!(isAuto || snap.exitNodeID);
            const reachable = !!(node && node.online && node.exitNodeOption);
            this._exitNodeWarnIcon.visible = wantsExit && !reachable;

            sub.addMenuItem(
                new PeerRow({
                    title: _("None"),
                    checked: !snap.exitNodeID && !isAuto,
                    onClick: () => this._withFeedback(
                        _("Clearing exit node"),
                        _("Exit node cleared"),
                        () => this._client.setExitNode(""),
                    ),
                }),
            );
            sub.addMenuItem(
                new PeerRow({
                    title: _("Auto"),
                    checked: isAuto,
                    onClick: () => this._withFeedback(
                        _("Selecting an exit node"),
                        _("Exit node: auto"),
                        () => this._client.setExitNode("auto:any"),
                    ),
                }),
            );

            // Render the union of the advertised exit nodes AND the
            // currently-selected peer (so a direct selection sticks in the
            // list with a checkmark even after the peer stops advertising
            // or goes offline). In auto mode we don't mark the auto-picked
            // peer as checked: only the "Auto" row is the user's choice.
            const displayNodes = [...snap.exitNodes];
            if (node && !isAuto && !displayNodes.some((p) => p.id === node.id))
                displayNodes.push(node);

            if (displayNodes.length === 0) {
                const empty = new InfoRow(_("No approved exit nodes"));
                empty.reactive = false;
                sub.addMenuItem(empty);
            } else {
                sub.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                for (const peer of displayNodes) {
                    // Use the Tailscale IP for --exit-node: hostnames can contain
                    // spaces which the CLI rejects as "invalid value".
                    const target = peer.ips[0] || peer.dnsName;
                    const isSelected = !isAuto && peer.exitNode;
                    const peerName = peer.hostname || peer.dnsName;
                    sub.addMenuItem(
                        new PeerRow({
                            title: peerName,
                            subtitle: peer.ips[0] ?? "",
                            online: peer.online,
                            checked: isSelected,
                            styleClass: isSelected
                                ? "tailscale-exit-node-active"
                                : "",
                            onClick: () => this._withFeedback(
                                _fmt(_("Routing through %s"), peerName),
                                _fmt(_("Exit node: %s"), peerName),
                                () => this._client.setExitNode(target),
                            ),
                        }),
                    );
                }
            }

            // Allow LAN access only matters when an exit node is active. Build
            // a fresh ToggleRow every render: PopupMenuBase.removeAll() above
            // destroys every existing menu item, so a long-lived field on the
            // toggle would hand us a disposed actor on the next click and
            // crash gnome-shell.
            if (snap.exitNodeID) {
                sub.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                const lanRow = new ToggleRow(_("Allow LAN access"), (v) =>
                    this._withFeedback(
                        v ? _("Enabling LAN access") : _("Disabling LAN access"),
                        v ? _("LAN access: on") : _("LAN access: off"),
                        () => this._client.setAllowLanAccess(v),
                    ),
                );
                lanRow.setChecked(snap.allowLanAccess);
                lanRow.setSensitive(!!snap.canControl);
                sub.addMenuItem(lanRow);
            }
        }

        _renderPeers(snap) {
            const sub = this._peersSubMenu.menu;
            sub.removeAll();

            const total = snap.peers.length;
            const online = snap.peers.filter((p) => p.online).length;
            this._peersSubMenu.label.text = _("Peers");
            this._peersPill.text = total ? `${online}/${total}` : "";
            this._peersPill.visible = total > 0;

            if (total === 0) {
                const empty = new InfoRow(_("No peers"));
                empty.reactive = false;
                sub.addMenuItem(empty);
                return;
            }

            for (const peer of snap.peers) {
                const ip = peer.ips[0] ?? "";
                sub.addMenuItem(
                    new PeerRow({
                        title: peer.hostname || peer.dnsName,
                        subtitle: ip
                            ? `${ip} • ${peer.os || ""}`.trim()
                            : peer.os,
                        online: peer.online,
                        onClick: () =>
                            this._copyToClipboard(ip || peer.dnsName),
                        onCopy: ip
                            ? () => this._copyToClipboard(ip)
                            : undefined,
                    }),
                );
            }
        }

        _renderAccounts(snap) {
            const sub = this._accountsSubMenu.menu;
            sub.removeAll();

            // Prefer the tailnet column (email of the tailnet owner) over the
            // account column (email of the logged-in user). The distinction is
            // only meaningful for shared/family tailnets; showing both would
            // clutter the menu. One label per row is enough.
            const accountTitle = (a) => a.tailnet || a.account || "";

            const currentFromList = snap.accounts.find((a) => a.current);
            const currentLabel =
                accountTitle(currentFromList || {}) ||
                snap.accountName ||
                _("No account");
            this._accountsSubMenu.label.text = _fmt(
                _("Account: %s"),
                currentLabel,
            );

            if (snap.accounts.length === 0) {
                if (snap.accountName) {
                    const row = new PeerRow({
                        title: snap.accountName,
                        checked: true,
                    });
                    row.reactive = false;
                    sub.addMenuItem(row);
                }
                if (!snap.canControl) {
                    const hint = new InfoRow(
                        _("Operator not set: switching disabled"),
                    );
                    hint.reactive = false;
                    sub.addMenuItem(hint);
                }
            } else {
                // Sort alphabetically so the order is stable across refreshes
                // (tailscale switch --list output order is not guaranteed).
                const sorted = [...snap.accounts].sort((a, b) =>
                    accountTitle(a).localeCompare(accountTitle(b)),
                );
                for (const acc of sorted) {
                    const label = accountTitle(acc);
                    sub.addMenuItem(
                        new PeerRow({
                            title: label,
                            checked: acc.current,
                            onClick: () => {
                                if (acc.current) return;
                                this._withFeedback(
                                    _fmt(_("Switching to %s"), label),
                                    _fmt(_("Active account: %s"), label),
                                    () => this._client.switchAccount(acc.id),
                                );
                            },
                        }),
                    );
                }
            }

            sub.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Paired Login / Logout buttons on a single row.
            const authRow = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: "tailscale-bottom-row",
            });
            const authBox = new St.BoxLayout({
                x_expand: true,
                style_class: "tailscale-bottom-buttons",
            });
            authRow.add_child(authBox);

            const loginBtn = new St.Button({
                label: _("Login"),
                x_expand: true,
                style_class: "button",
            });
            loginBtn.connect("clicked", () => {
                this._closeAllMenus();
                this._withFeedback(
                    _("Opening Tailscale login"),
                    _("Login flow started"),
                    () => this._client.login(),
                );
            });
            authBox.add_child(loginBtn);

            if (!snap.loggedOut) {
                const logoutBtn = new St.Button({
                    label: _("Logout"),
                    x_expand: true,
                    style_class: "button",
                });
                logoutBtn.connect("clicked", () => {
                    this._closeAllMenus();
                    this._withFeedback(
                        _("Logging out"),
                        _("Logged out"),
                        () => this._client.logout(),
                    );
                });
                authBox.add_child(logoutBtn);
            }
            sub.addMenuItem(authRow);
        }

        /* --------------------------- Features ----------------------------- */

        // Honor the per-feature prefs toggles AND the per-tailnet
        // availability cache. Called after the main render pass has marked
        // all items visible; this trims down to what the user has enabled
        // AND the admin has allowed. The Send/Funnel separator hides when
        // both halves of its block are off so we don't get an orphan
        // divider.
        _applyFeatureGates() {
            const s = this._settings;
            this._exitNodeSubMenu.visible &&= s.get_boolean("feature-exit-nodes");
            this._acceptDNSRow.visible    &&= s.get_boolean("feature-dns");
            this._routesToggle.visible    &&= s.get_boolean("feature-routes");
            this._shieldsUpRow.visible    &&= s.get_boolean("feature-shields-up");
            this._runSSHRow.visible       &&= s.get_boolean("feature-ssh-server");

            // ACL-gated features go further: hide them when the daemon told
            // us the tailnet doesn't allow them, so the user can't try to
            // wire up a funnel that the control plane would refuse.
            const taildrop = s.get_boolean("feature-taildrop") &&
                s.get_boolean("feature-taildrop-available");
            const funnels  = s.get_boolean("feature-funnels") &&
                s.get_boolean("feature-funnels-available");
            this._acceptFilesRow.visible  &&= taildrop;
            this._sendFileRow.visible     &&= taildrop;
            this._funnelSubMenu.visible   &&= funnels;
            this._funnelSeparator.visible &&= (taildrop || funnels);
        }

        /* --------------------------- Taildrop ----------------------------- */

        // Mirror the gsetting + drive the receiver process. The toggle row
        // commits the bool to dconf so the choice survives session restarts
        // and the prefs dialog can flip the same switch.
        _setAcceptFiles(value) {
            this._settings.set_boolean("taildrop-accept", !!value);
            const inbox = this._settings.get_string("taildrop-inbox");
            this._client.setAcceptFiles(!!value, inbox);
            ToastManager.show({
                level: "success",
                message: value
                    ? _("Accepting Taildrop files")
                    : _("Taildrop receiver stopped"),
            });
        }

        // Send flow: zenity file picker (skipped if files pre-selected, e.g.
        // from the Nautilus DBus call) → in-shell native peer picker → cp.
        // Peers come from `tailscale file cp --targets`, which only lists
        // nodes that can actually receive Taildrop files.
        async _runSendFlow(preselectedFiles) {
            let files = preselectedFiles;
            if (!files || files.length === 0) {
                const fileRes = await _spawnAsync([
                    "zenity", "--file-selection", "--multiple",
                    "--separator=\n",
                    "--title=Send files via Taildrop",
                ]);
                if (!fileRes.ok || !fileRes.stdout.trim()) return;
                files = fileRes.stdout.trim().split("\n").filter((f) => f);
            }

            const { targets, denied } = await this._client.fileTargets();
            if (denied) {
                ToastManager.show({
                    level: "error",
                    message: _("Taildrop is disabled for this tailnet by your admin."),
                });
                return;
            }
            const online = targets.filter((t) => !t.offline);
            if (online.length === 0) {
                ToastManager.show({
                    level: "error",
                    message: _("No online peers available to receive files"),
                });
                return;
            }

            const dialog = new SendFileDialog({
                files,
                peers: online,
                onPick: (peer) => {
                    if (!peer) return;
                    const label = files.length === 1
                        ? files[0].split("/").pop()
                        : _fmt(_("%d files"), files.length);
                    this._withFeedback(
                        _fmt(_("Sending %s to %s"), label, peer.host),
                        _fmt(_("Sent to %s"), peer.host),
                        () => this._client.sendFile(peer.ip, files),
                    );
                },
            });
            dialog.open();
        }

        /* --------------------------- helpers ------------------------------ */

        // Close both the toggle's secondary menu AND the parent Quick
        // Settings panel. Plain `this.menu.close()` only closes the former,
        // leaving the QS popup hanging on top of any modal we open next.
        _closeAllMenus() {
            try { this.menu.close(); } catch (_) {}
            const qs = Main.panel.statusArea.quickSettings;
            if (qs?.menu?.isOpen) {
                try { qs.menu.close(); } catch (_) {}
            }
        }

        // Wrap an async client call with a pending toast that resolves in
        // place to success / error. Enforces a minimum spinner visibility
        // so instant operations don't flash. Suppresses the duplicate
        // notify-info / error signal that some client methods emit by
        // sitting in _activeOp while running.
        async _withFeedback(pending, success, fn) {
            const toast = ToastManager.show({
                level: "pending",
                message: pending,
            });
            this._activeOp = toast;
            const startMs = GLib.get_monotonic_time() / 1000;
            let result;
            try {
                result = await fn();
            } catch (e) {
                result = { ok: false, message: String(e?.message ?? e) };
            }
            const floor = ToastManager.minSpinnerMs;
            const elapsed = (GLib.get_monotonic_time() / 1000) - startMs;
            if (floor > 0 && elapsed < floor) {
                await new Promise((resolve) => {
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT,
                        Math.ceil(floor - elapsed), () => {
                            resolve();
                            return GLib.SOURCE_REMOVE;
                        });
                });
            }
            if (this._activeOp === toast) this._activeOp = null;
            if (result && result.ok === false) {
                toast.update({
                    level: "error",
                    message: result.message || _("Operation failed"),
                });
            } else {
                toast.update({ level: "success", message: success });
            }
            return result;
        }

        _copyToClipboard(text) {
            if (!text) return;
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD,
                text,
            );
            ToastManager.show({
                level: "success",
                message: _fmt(_("Copied %s to clipboard"), text),
            });
        }

        destroy() {
            for (const id of this._signalIds) this._client.disconnect(id);
            for (const id of this._settingsIds) this._settings.disconnect(id);
            this._signalIds = [];
            this._settingsIds = [];
            super.destroy();
        }
    },
);
