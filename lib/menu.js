// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// QuickMenuToggle for Tailscale. The whole menu is rebuilt from the
// client's snapshot on every 'state-changed'. The body toggle uses
// toggleMode: true so `this.checked` flips synchronously on click; the
// next poll snaps it back if the action couldn't actually run.
//
// The rows it is built from live in ./menu/rows.js, and the two dialogs it
// opens own their whole feature in ./menu/send-dialog.js and
// ./menu/funnels-dialog.js.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Notifier, Category } from './notify.js';
import { backendStatus } from './tailscale.js';
import {
    fmt as _fmt, gicon as _gicon, showInFileManager as _showInFileManager,
} from './util.js';
import {
    ICON_ACTIVE, ICON_COPY, ICON_DISABLED, InfoRow, PeerRow,
    RoutesSubToggle, SelfRow, ToggleRow, copyTargetsFor, decorateWithPill,
} from './menu/rows.js';
import {
    SendFileDialog, archiveName, makeArchive, removeTree,
} from './menu/send-dialog.js';
import { FunnelsDialog, funnelPorts } from './menu/funnels-dialog.js';

const TAILSCALE_ADMIN_URL = 'https://login.tailscale.com/admin/machines';

// Identifies the self row in _openCopyKey, alongside the peers' dnsName.
const SELF_COPY_KEY = '\u0000self';

/**
 * How the signed-in account relates to a tailnet, read off the two names
 * the daemon already reports rather than guessed: the API exposes no role
 * field, but the shape of the tailnet name settles it.
 *
 *   - same string as the account  -> the user's own personal tailnet
 *   - another e-mail address      -> someone else's personal tailnet
 *   - a bare domain, no "@"       -> an organisation's tailnet
 *
 * @param {{tailnet: string, account: string}} acc
 * @returns {string} account line for the row, e.g. "me@example.com (Guest)"
 */
function _accountSubtitle(acc) {
    const account = acc.account || '';
    const tailnet = acc.tailnet || '';
    if (!account) return '';
    let kind;
    if (!tailnet || tailnet === account) kind = _('Personal account');
    else if (tailnet.includes('@')) kind = _('Guest account');
    else kind = _('Organisation account');
    return _fmt(_('%s (%s)'), account, kind);
}

export function openAdminPanel() {
    try {
        Gio.AppInfo.launch_default_for_uri(TAILSCALE_ADMIN_URL, null);
    } catch {
        Notifier.notify({
            category: Category.ERRORS,
            level: 'error',
            message: _fmt(_('Could not open %s'), TAILSCALE_ADMIN_URL),
        });
    }
}

// The user-facing half of backendStatus(). Two states, two sentences, and
// nowhere else that gets to word them.
function backendMessage(status) {
    return status === 'not-installed'
        ? _('Tailscale is not installed')
        : _('Tailscale is not running');
}

/**
 * The gate for everything that reaches past the menu: the keybindings and
 * the Nautilus D-Bus method. A hidden arrow stops nothing that does not go
 * through the arrow.
 *
 * @param {object} snap the client's current snapshot
 * @param {string} category one of Category, for the refusal
 * @returns {boolean} true when the caller may proceed
 */
export function requireBackend(snap, category) {
    const status = backendStatus(snap);
    if (status === 'ready') return true;
    Notifier.notify({
        category,
        level: 'error',
        message: backendMessage(status),
    });
    return false;
}

// This project's status vocabulary: what the Quick Settings pill shows for
// a snapshot that isn't cleanly "running". Exported so extension.js's
// watcher-messages table can reuse it for the connection-ended notification
// (a Starting phase that resolved to something other than Running) instead
// of duplicating these five lines and letting the two drift apart.
export function statusText(snap) {
    // Ahead of everything else: neither of these two is a thing you wait
    // out, and neither resolves itself.
    const status = backendStatus(snap);
    if (status !== 'ready') return backendMessage(status);
    if (snap.loggedOut) return _('Logged out');
    if (snap.backendState === 'NeedsLogin') return _('Login required');
    if (snap.running) return snap.accountName || _('Connected');
    return _('Disconnected');
}

/**
 * Why the connection cannot be switched right now, or null when it can.
 *
 * On/off only makes sense once there is BOTH an operator (canControl) and an
 * authenticated account: without the operator every CLI call hits "access
 * denied", and without an account "up" starts an unwanted login flow that
 * wipes prefs.
 *
 * The Quick Settings switch and the keybinding both ask this and answer it
 * differently, since the switch can put itself back and open the menu it
 * lives in while the keybinding has neither. What they must not do is
 * disagree on the diagnosis, which is why the order lives here rather than
 * twice. Logged out outranks operator-missing: login restores the operator
 * pref by itself, so prompting first would only add an elevation.
 *
 * @param {object} snap the client's current snapshot
 * @returns {'needs-login'|'needs-operator'|'not-settled'|null}
 */
export function connectionBlocker(snap) {
    if (snap.loggedOut || snap.backendState === 'NeedsLogin') return 'needs-login';
    if (!snap.canControl) return 'needs-operator';
    if (snap.backendState === 'NoState') return 'not-settled';
    return null;
}

/**
 * Connect or disconnect, with the feedback notification that names it.
 *
 * @param {object} client the TailscaleClient to drive
 * @param {boolean} wanted the state the user just asked for
 */
export function setConnection(client, wanted) {
    if (wanted) {
        Notifier.withFeedback(
            Category.CONNECTION,
            _('Connecting Tailscale'),
            _('Tailscale connected'),
            () => client.up(),
        );
    } else {
        Notifier.withFeedback(
            Category.CONNECTION,
            _('Disconnecting Tailscale'),
            _('Tailscale disconnected'),
            () => client.down(),
        );
    }
}

// Find a Mutter window that looks like our extension's prefs window and
// raise/focus it. openPreferences() handles the "spawn or single-instance
// activate" side, but on some setups the existing window stays buried under
// the shell; activating it explicitly with the current timestamp brings it
// reliably on top.
function _activatePrefsWindow(extension) {
    const name = extension.metadata.name;
    if (!name) return false;
    const actors = global.get_window_actors();
    for (const actor of actors) {
        const win = actor.meta_window;
        if (!win) continue;
        const title = win.get_title() || '';
        if (title === name || title.startsWith(`${name} `)) {
            win.activate(global.get_current_time());
            return true;
        }
    }
    return false;
}

export const TailscaleToggle = GObject.registerClass(
    class TailscaleToggle extends QuickSettings.QuickMenuToggle {
        _init({ extension, client }) {
            super._init({
                title: 'Tailscale',
                subtitle: _('Loading…'),
                gicon: _gicon(extension, ICON_DISABLED),
                toggleMode: true,
            });

            this._extension = extension;
            this._client = client;
            this._settings = extension.getSettings();
            this._raiseTimeoutId = 0;
            this._portalSubId = 0;
            this._openDialog = null;
            // The Funnels dialog stays up across adds and removes, so it
            // is held separately from _openDialog: _render feeds it every
            // snapshot for as long as it is on screen.
            this._funnelsDialog = null;
            // Which row, if any, currently has its copy chooser expanded.
            // Held here rather than on the row because peer rows are rebuilt
            // from scratch on every state change.
            this._openCopyKey = null;

            this.connectObject('clicked', () => this._onUserClick(), this);

            // Fold an expanded chooser away with the menu that holds it.
            // Nothing else resets it: the rows outlive a close/open cycle
            // when no state change happens in between, so the chooser would
            // still be hanging open the next time the panel is opened.
            this._menuStateId = this.menu.connect(
                'open-state-changed', (_m, isOpen) => {
                    if (isOpen || this._openCopyKey === null) return;
                    this._openCopyKey = null;
                    this._render(this._client.snapshot);
                });

            // Re-render when the Taildrop accept toggle is changed elsewhere
            // (prefs dialog, dconf-editor). Availability is not watched here
            // any more: it rides on the snapshot, so a grant or a revocation
            // arrives through 'state-changed' like everything else.
            this._settings.connectObject(
                'changed::taildrop-accept',
                () => this._render(this._client.snapshot),
                this,
            );

            this._client.connectObject(
                'state-changed', (_c, snap) => this._render(snap),
                'error', (_c, msg) => Notifier.notify({
                    category: Category.ERRORS,
                    level: 'error',
                    message: msg,
                    spontaneous: true,
                }),
                // Category travels with the signal now (see tailscale.js):
                // notify-info carries heterogeneous messages (login, funnel,
                // Taildrop transfers, …) and each must be governed by the
                // switch its Preferences wording actually promises, not by
                // one hardcoded category for all of them.
                'notify-info', (_c, msg, category) => Notifier.notify({
                    category,
                    level: 'success',
                    message: msg,
                    spontaneous: true,
                }),
                'file-received', (_c, path, size) =>
                    this._notifyFileReceived(path, size),
                this,
            );

            this.menu.setHeader(_gicon(extension, ICON_DISABLED), 'Tailscale');

            this._buildMenu();
            this._render(this._client.snapshot);
        }

        /* --------------------------- menu skeleton ------------------------ */

        _buildMenu() {
            // Operator-not-set row: label + one-click "Set operator" button
            // that runs `pkexec tailscale set --operator=$USER`. The user
            // gets a polkit password prompt instead of having to copy a
            // command into a terminal.
            this._operatorRow = this._makeOperatorRow();
            this._operatorRow.visible = false;
            this.menu.addMenuItem(this._operatorRow);

            this._selfRow = new SelfRow();
            this.menu.addMenuItem(this._selfRow);

            this._accountsSubMenu = new PopupMenu.PopupSubMenuMenuItem(
                _('Tailnet'),
                true,
            );
            this.menu.addMenuItem(this._accountsSubMenu);

            this._sep1 = new PopupMenu.PopupSeparatorMenuItem();
            this.menu.addMenuItem(this._sep1);

            this._peersSubMenu = new PopupMenu.PopupSubMenuMenuItem(
                _('Peers'),
                true,
            );
            this._peersPill = decorateWithPill(this._peersSubMenu);
            this.menu.addMenuItem(this._peersSubMenu);

            this._exitNodeSubMenu = new PopupMenu.PopupSubMenuMenuItem(
                _('Exit node'),
                true,
            );
            // No warning glyph here: the pill already spells the state out
            // in words ("Auto (None)", "Offline (…)"), and the panel
            // indicator carries the same signal for anyone not looking at
            // the menu. Two glyphs for one fact was one too many.
            this._exitNodePill = decorateWithPill(this._exitNodeSubMenu);
            this.menu.addMenuItem(this._exitNodeSubMenu);

            this._sep2 = new PopupMenu.PopupSeparatorMenuItem();
            this.menu.addMenuItem(this._sep2);

            // DNS first (more commonly toggled than routes).
            this._acceptDNSRow = new ToggleRow(_('Magic DNS'), (v) =>
                Notifier.withFeedback(
                    Category.NETWORK,
                    v ? _('Enabling Magic DNS') : _('Disabling Magic DNS'),
                    v ? _('Magic DNS: on') : _('Magic DNS: off'),
                    () => this._client.setAcceptDNS(v),
                ),
            );
            this.menu.addMenuItem(this._acceptDNSRow);

            // Combined toggle + read-only submenu for routes.
            this._routesToggle = new RoutesSubToggle((v) =>
                Notifier.withFeedback(
                    Category.NETWORK,
                    v ? _('Enabling Accept routes') : _('Disabling Accept routes'),
                    v ? _('Accept routes: on') : _('Accept routes: off'),
                    () => this._client.setAcceptRoutes(v),
                ),
            );
            this.menu.addMenuItem(this._routesToggle);

            // Taildrop accept toggle sits right below Accept routes.
            this._acceptFilesRow = new ToggleRow(_('Accept files'),
                (v) => this._setAcceptFiles(v));
            this.menu.addMenuItem(this._acceptFilesRow);

            this._shieldsUpRow = new ToggleRow(_('Shields up'), (v) =>
                Notifier.withFeedback(
                    Category.NETWORK,
                    v ? _('Enabling Shields up') : _('Disabling Shields up'),
                    v ? _('Shields up: on') : _('Shields up: off'),
                    () => this._client.setShieldsUp(v),
                ),
            );
            this.menu.addMenuItem(this._shieldsUpRow);

            this._runSSHRow = new ToggleRow(_('Run SSH server'), (v) =>
                Notifier.withFeedback(
                    Category.NETWORK,
                    v ? _('Enabling SSH server') : _('Disabling SSH server'),
                    v ? _('SSH server: on') : _('SSH server: off'),
                    () => this._client.setRunSSH(v),
                ),
            );
            this.menu.addMenuItem(this._runSSHRow);

            // Single separator before the file-transfer / funnel block.
            this._funnelSeparator = new PopupMenu.PopupSeparatorMenuItem();
            this.menu.addMenuItem(this._funnelSeparator);

            // Two doors, one line. Both open a dialog that owns its whole
            // feature (the picker and the recipients for Taildrop, the
            // published list and the add form for Funnel), so neither has
            // anything left to show in the menu itself. That is what let
            // the Funnel submenu, its pill and its inline "+" go: a list
            // you can only read is worth less here than the room it took,
            // and the same list is one click away with a remove button
            // beside every entry.
            //
            // The two keybindings reach the very same calls through
            // Indicator.sendFiles() and Indicator.openFunnels().
            this._transferRow = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
                style_class: 'tailscale-bottom-row',
            });
            const transferBox = new St.BoxLayout({
                x_expand: true,
                style_class: 'tailscale-bottom-buttons tailscale-transfer-buttons',
            });
            this._transferRow.add_child(transferBox);

            this._sendFileBtn = new St.Button({
                label: _('Taildrop'),
                x_expand: true,
                style_class: 'button',
            });
            this._sendFileBtn.connect('clicked', () => {
                this._closeAllMenus();
                this.runSendFlow();
            });
            transferBox.add_child(this._sendFileBtn);

            this._funnelBtn = new St.Button({
                label: _('Funnels'),
                x_expand: true,
                style_class: 'button',
            });
            this._funnelBtn.connect('clicked', () => {
                this._closeAllMenus();
                this._runFunnelsFlow();
            });
            transferBox.add_child(this._funnelBtn);

            this.menu.addMenuItem(this._transferRow);

            this._sep3 = new PopupMenu.PopupSeparatorMenuItem();
            this.menu.addMenuItem(this._sep3);

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
                // Close BOTH the toggle menu and the parent QuickSettings
                // panel before opening prefs so the new window receives
                // focus instead of the shell stealing it back.
                const id = this.menu.connect('open-state-changed', (_m, isOpen) => {
                    if (isOpen) return;
                    this.menu.disconnect(id);
                    this.openPreferences();
                });
                this._closeAllMenus();
            });
            buttonBox.add_child(settingsBtn);

            this._adminBtn = new St.Button({
                label: _('Admin panel'),
                x_expand: true,
                style_class: 'button',
            });
            this._adminBtn.connect('clicked', () => {
                this._closeAllMenus();
                openAdminPanel();
            });
            buttonBox.add_child(this._adminBtn);

            this.menu.addMenuItem(this._bottomRow);

            settingsBtn.visible = Main.sessionMode.allowSettings;
            this.menu._settingsActions = this.menu._settingsActions ?? {};
            this.menu._settingsActions[this._extension.uuid] = settingsBtn;

            // All items that are hidden when the operator is not set.
            this._mainItems = [
                this._selfRow,
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
                this._transferRow,
                this._sep3,
            ];
        }

        // "Operator not set" + [Set operator] button. Used as the
        // persistent top-level gate row AND rebuilt inside the Account
        // submenu on every render while control is denied (the submenu is
        // wiped by removeAll(), so it needs a fresh instance each pass).
        _makeOperatorRow() {
            const row = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false,
            });
            const box = new St.BoxLayout({ x_expand: true });
            box.add_child(
                new St.Label({
                    text: _('Operator not set'),
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            );
            const btn = new St.Button({
                label: _('Set operator'),
                style_class: 'button',
            });
            btn.connect('clicked', () => {
                Notifier.withFeedback(
                    Category.ACCOUNT,
                    _('Granting operator privilege'),
                    _('Operator set'),
                    () => this._client.setOperator(),
                );
            });
            box.add_child(btn);
            row.add_child(box);
            return row;
        }

        /* ----------------------------- actions ---------------------------- */

        /**
         * Open the preferences window and make sure it comes up on top: an
         * already-open one can stay buried under the shell, and activating
         * it with the current timestamp is what raises it. The delay is
         * tracked on the toggle (and re-armed rather than stacked) so
         * destroy() can remove it.
         */
        openPreferences() {
            this._extension.openPreferences();
            if (this._raiseTimeoutId)
                GLib.source_remove(this._raiseTimeoutId);
            this._raiseTimeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, 120, () => {
                    this._raiseTimeoutId = 0;
                    _activatePrefsWindow(this._extension);
                    return GLib.SOURCE_REMOVE;
                });
        }

        // Where a click goes when there is no backend behind the button.
        // The preferences window is reduced to its Help page in this state,
        // and that page names which of the two it is and what to do about
        // it, more than a notification could carry, and it stays on screen
        // while the user acts on it.
        //
        // Falls back to the notification in a session mode that forbids
        // opening settings, which is also the one where the menu hides its
        // own Extension settings button: a click that did nothing at all
        // would read as a broken toggle.
        //
        // Public because the show-menu keybinding lands here too, through
        // the indicator, the way it already reaches runSendFlow and
        // openFunnels.
        reportUnusableBackend(snap) {
            if (!Main.sessionMode.allowSettings) {
                requireBackend(snap, Category.CONNECTION);
                return;
            }
            this._closeAllMenus();
            this.openPreferences();
        }

        _onUserClick() {
            const snap = this._client.snapshot;
            // Nothing to switch on, and no menu left to explain it: the
            // arrow is gone in this state. Put the switch back where it was
            // and hand the user the page that can explain it.
            if (backendStatus(snap) !== 'ready') {
                this.checked = false;
                this.reportUnusableBackend(snap);
                return;
            }
            // Revert the toggle visual and steer the user toward the action
            // that would actually unblock them.
            const blocker = connectionBlocker(snap);
            if (blocker) {
                this.checked = !!snap.running;
                if (blocker === 'needs-login') {
                    Notifier.notify({
                        category: Category.CONNECTION,
                        level: 'info',
                        message: _('Login required (see Account menu)'),
                    });
                    this.menu.open();
                } else if (blocker === 'needs-operator') {
                    // Fire the pkexec prompt directly so the user doesn't
                    // have to dig into the menu for "Set operator".
                    this._client.setOperator();
                } else {
                    // NoState: daemon still starting or unreachable.
                    Notifier.notify({
                        category: Category.CONNECTION,
                        level: 'info',
                        message: statusText(snap),
                    });
                }
                return;
            }
            setConnection(this._client, this.checked);
        }

        /* ------------------------------ render ---------------------------- */

        _render(snap) {
            if (!snap) return;

            this.checked = snap.running;
            this.gicon = _gicon(
                this._extension,
                snap.running ? ICON_ACTIVE : ICON_DISABLED,
            );

            // No subtitle on either surface. The toggle already says whether
            // it is on, and the menu below spells out the detail; a second
            // status string only competed with the title for attention.
            // Leaving it null is what lets the shell centre the title
            // against the icon instead of stacking two lines.
            this.subtitle = null;

            this.menu.setHeader(
                _gicon(
                    this._extension,
                    snap.running ? ICON_ACTIVE : ICON_DISABLED,
                ),
                'Tailscale',
            );

            // No CLI on PATH, or a daemon that does not answer: every row
            // below drives a command that cannot run. The menu does not
            // open at all rather than open onto a dozen dead controls, and
            // the arrow goes with it: `menu-enabled` is QuickMenuToggle's
            // own property for exactly this, so nothing private is touched.
            // What is left is a plain toggle whose click says why. This
            // gate is first because it outranks the others: there is no
            // operator to set and no account to log into without a backend
            // to ask.
            if (backendStatus(snap) !== 'ready') {
                // A Taildrop picker or the Funnels list can be on screen
                // when the package goes. Both are built out of a snapshot
                // that no longer describes anything, and every button in
                // them now fails; the 'closed' handlers clear the two
                // references. Same call the transfer buttons make.
                this._openDialog?.close();
                this._funnelsDialog?.close();
                // Hiding the arrow does not close what it already opened.
                this.menu.close();
                this.menuEnabled = false;
                return;
            }
            this.menuEnabled = true;

            const needsLogin = snap.loggedOut ||
                snap.backendState === 'NeedsLogin';

            // Operator gate: when control is denied while logged IN, show
            // only the operator row and the Extension Settings button.
            // While logged OUT the gate is skipped even without operator:
            // `login` restores the pref by itself (--operator flag), so
            // the Login entry must stay reachable: that is what keeps
            // logout at a single polkit prompt.
            if (!snap.canControl && !needsLogin) {
                this._operatorRow.visible = true;
                for (const item of this._mainItems) item.visible = false;
                this._adminBtn.visible = false;
                return;
            }

            this._operatorRow.visible = false;
            this._adminBtn.visible = true;

            // No active account: show only the accounts submenu (for login).
            // Hide all network settings: they require an authenticated session.
            if (needsLogin) {
                for (const item of this._mainItems)
                    item.visible = item === this._accountsSubMenu;
                this._renderAccounts(snap);
                return;
            }

            for (const item of this._mainItems) item.visible = true;

            this._selfIp = snap.selfIps[0] ?? '';
            const selfName = snap.hostname || '';
            this._selfRow.update({
                title: selfName || this._selfIp || _('This device'),
                subtitle: selfName ? this._selfIp : '',
                online: snap.running,
                copyIconName: ICON_COPY,
                copyTargets: copyTargetsFor({
                    ip: this._selfIp,
                    name: selfName,
                    magicDNS: snap.acceptDNS,
                }),
                onCopy: (value) => this._copyToClipboard(value),
                copyOpen: this._openCopyKey === SELF_COPY_KEY,
                onCopyToggle: (open) => {
                    this._openCopyKey = open ? SELF_COPY_KEY : null;
                },
            });

            this._renderAccounts(snap);
            this._renderPeers(snap);
            this._renderExitNodes(snap);
            this._renderRoutes(snap);
            // The funnel list lives in its dialog now. Feeding it from here
            // is what makes an add or a remove show up in it without the
            // dialog having to poll or close: every snapshot the menu
            // renders from reaches the open dialog too.
            this._funnelsDialog?.render(snap);

            // Apply gates last: the loop above turned every main item back
            // on unconditionally, so the gate must have the final word.
            this._applyFeatureGates(snap);

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
            this._acceptDNSRow.setAccessory(snap.magicDNSSuffix || '');

            this._shieldsUpRow.setChecked(snap.shieldsUp);
            this._runSSHRow.setChecked(snap.runSSH);

            // Taildrop toggle reflects the dconf setting (the receiver
            // process state is derived from it, not the other way around).
            this._acceptFilesRow.setChecked(
                this._settings.get_boolean('taildrop-accept'),
            );
        }

        // Public entry point for the keyboard shortcut, which fires with no
        // menu open. Closing first matches what the menu button does, so the
        // dialog is never stacked under the Quick Settings popup.
        openFunnels() {
            this._closeAllMenus();
            return this._runFunnelsFlow();
        }

        _runFunnelsFlow() {
            const snap = this._client.snapshot;
            if (!requireBackend(snap, Category.FUNNEL)) return;
            // Reachable with the menu button hidden: the keyboard shortcut
            // fires wherever the user is. Saying so beats a dialog whose
            // every action would come back refused by the control plane,
            // the same answer runSendFlow gives when Taildrop is off for
            // the tailnet.
            if (snap.funnelsAvailable === false) {
                Notifier.notify({
                    category: Category.FUNNEL,
                    level: 'error',
                    message: _('Funnel is disabled for this tailnet by your admin.'),
                });
                return;
            }
            // A second press with the dialog already up is a no-op rather
            // than a second dialog: the shortcut is reachable from anywhere
            // and nothing else would close the first one.
            if (this._funnelsDialog) return;

            const dialog = new FunnelsDialog({
                extension: this._extension,
                onAdd: (pick) => this._addFunnel(pick),
                onRemove: (f) => this._removeFunnel(f),
                onCopy: (url) => this._copyToClipboard(url),
            });
            this._funnelsDialog = dialog;
            dialog.connect('closed', () => {
                if (this._funnelsDialog === dialog) this._funnelsDialog = null;
            });
            // Seed it before it is on screen, so it opens on the list it
            // will keep showing rather than blinking through an empty one.
            dialog.render(snap);
            this._showDialog(dialog);
        }

        // Reports name the public port: now that it is user-picked it is
        // the funnel's identity: it is the port in the URL.
        _removeFunnel(f) {
            return Notifier.withFeedback(
                Category.FUNNEL,
                _fmt(_('Removing funnel %s'), funnelPorts(f)),
                _fmt(_('Funnel removed %s'), funnelPorts(f)),
                () => this._client.removeFunnel(f.httpsPort),
            );
        }

        async _addFunnel({ localText, httpsPort }) {
            const trimmed = (localText ?? '').trim();
            const localPort = parseInt(trimmed, 10);
            if (!trimmed || isNaN(localPort) || localPort < 1 || localPort > 65535) {
                Notifier.notify({
                    category: Category.FUNNEL,
                    level: 'error',
                    message: _('Invalid port number'),
                });
                return;
            }

            // addFunnel may return notEnabled (browser approval needed); in
            // that case withFeedback's "success" branch ends up wrong, so we
            // peek the result and override the report with an info message.
            let openedApproval = null;
            const r = await Notifier.withFeedback(
                Category.FUNNEL,
                // external:internal, the order docker -p uses, so the
                // mapping reads the same way here as everywhere else.
                _fmt(_('Adding funnel %d:%d'), httpsPort, localPort),
                _fmt(_('Funnel added %d:%d'), httpsPort, localPort),
                async () => {
                    const res = await this._client.addFunnel(localPort, httpsPort);
                    if (res.notEnabled) {
                        openedApproval = res.url;
                        // Treat as a success-ish outcome (no error) so the
                        // report doesn't go red; we re-message it just below.
                        return { ok: true, message: '' };
                    }
                    return res;
                },
            );
            if (openedApproval) {
                try {
                    Gio.AppInfo.launch_default_for_uri(openedApproval, null);
                } catch {
                    Notifier.notify({
                        category: Category.FUNNEL,
                        level: 'error',
                        message: _fmt(_('Could not open %s'), openedApproval),
                    });
                }
                Notifier.notify({
                    category: Category.FUNNEL,
                    level: 'info',
                    message: _('Approve Funnel in the browser, then retry.'),
                });
            }
            return r;
        }

        _renderRoutes(snap) {
            const sub = this._routesToggle.menu;
            sub.removeAll();

            // Split off the catch-all routes that an active exit node injects
            // (0.0.0.0/0, ::/0). They aren't subnet routes the user actively
            // accepted via --accept-routes (they ride on the exit-node
            // selection), so listing them inline with real subnets is
            // misleading. Show them under a separate header instead.
            const isDefault = (cidr) => cidr === '0.0.0.0/0' || cidr === '::/0';
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

            // Pill counts only meaningful subnet routes: the catch-alls are
            // intentionally excluded.
            if (subnetRoutes.length > 0) {
                this._routesToggle.setPill(
                    subnetRoutes.length === 1
                        ? _('1 route')
                        : _fmt(_('%d routes'), subnetRoutes.length),
                );
            } else {
                this._routesToggle.setPill('');
            }

            const addPeerRow = (route) => {
                const row = new PeerRow({
                    title: route.cidr,
                    subtitle: route.peer ? _fmt(_('via %s'), route.peer) : '',
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
                    text: _('Through exit node'),
                    style_class: 'tailscale-peer-ip',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                }));
                sub.addMenuItem(header);
                for (const route of exitDefaults) addPeerRow(route);
            }
        }

        _renderExitNodes(snap) {
            const sub = this._exitNodeSubMenu.menu;
            sub.removeAll();

            this._exitNodeSubMenu.label.text = _('Exit node');

            const isAuto = snap.autoExitNode;
            const node = snap.currentExitNode;
            const nameOf = (n) => n.hostname || n.dnsName.split('.')[0] || '';

            // Pill reflects the EFFECTIVE routing state, not just the
            // pref. Three failure modes to surface:
            //   - peer offline (unreachable from the tailnet)
            //   - peer online but stopped advertising itself as exit node
            //   - in auto mode, both of the above
            let pill;
            if (isAuto) {
                if (node && node.online && node.exitNodeOption)
                    pill = _fmt(_('Auto (%s)'), nameOf(node));
                else pill = _('Auto (None)');
            } else if (node) {
                const name = nameOf(node);
                if (!node.online) pill = _fmt(_('Offline (%s)'), name);
                else if (!node.exitNodeOption)
                    pill = _fmt(_('Disabled (%s)'), name);
                else pill = name;
            } else {
                pill = _('None');
            }
            this._exitNodePill.text = pill;
            this._exitNodePill.visible = true;

            sub.addMenuItem(
                new PeerRow({
                    title: _('None'),
                    checked: !snap.exitNodeID && !isAuto,
                    onClick: () => Notifier.withFeedback(
                        Category.EXIT_NODE,
                        _('Clearing exit node'),
                        _('Exit node cleared'),
                        () => this._client.setExitNode(''),
                    ),
                }),
            );
            sub.addMenuItem(
                new PeerRow({
                    title: _('Auto'),
                    checked: isAuto,
                    onClick: () => Notifier.withFeedback(
                        Category.EXIT_NODE,
                        _('Selecting an exit node'),
                        _('Exit node: auto'),
                        () => this._client.setExitNode('auto:any'),
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
                const empty = new InfoRow(_('No approved exit nodes'));
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
                            subtitle: peer.ips[0] ?? '',
                            online: peer.online,
                            checked: isSelected,
                            styleClass: isSelected
                                ? 'tailscale-exit-node-active'
                                : '',
                            onClick: () => Notifier.withFeedback(
                                Category.EXIT_NODE,
                                _fmt(_('Routing through %s'), peerName),
                                _fmt(_('Exit node: %s'), peerName),
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
                const lanRow = new ToggleRow(_('Allow LAN access'), (v) =>
                    Notifier.withFeedback(
                        Category.NETWORK,
                        v ? _('Enabling LAN access') : _('Disabling LAN access'),
                        v ? _('LAN access: on') : _('LAN access: off'),
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
                const name = peer.hostname || peer.dnsName.split('.')[0] || '';
                // Survives the rebuild below; dnsName is the only field
                // guaranteed unique across peers.
                const key = peer.dnsName || name;
                sub.addMenuItem(
                    new PeerRow({
                        title: name || peer.dnsName,
                        subtitle: ip
                            ? `${ip} • ${peer.os || ''}`.trim()
                            : peer.os,
                        online: peer.online,
                        // No onClick: copying is the copy button's job. A
                        // whole row that silently copies on contact fires
                        // on every stray click, including the ones aimed
                        // at scrolling the list.
                        onCopy: (value) => this._copyToClipboard(value),
                        copyIconName: ICON_COPY,
                        copyTargets: copyTargetsFor({
                            ip,
                            name,
                            magicDNS: snap.acceptDNS,
                        }),
                        copyOpen: this._openCopyKey === key,
                        onCopyToggle: (open) => {
                            this._openCopyKey = open ? key : null;
                        },
                    }),
                );
            }
        }

        _renderAccounts(snap) {
            const sub = this._accountsSubMenu.menu;
            sub.removeAll();

            // What the user switches between is tailnets, not logins. One
            // account can reach several tailnets (being a guest in someone
            // else's tailnet is the ordinary case), so the tailnet is the
            // identity that distinguishes the profiles, and the account is
            // usually the same string repeated.
            const tailnetTitle = (a) => a.tailnet || a.account || '';

            const currentFromList = snap.accounts.find((a) => a.current);
            const currentLabel =
                tailnetTitle(currentFromList || {}) ||
                snap.accountName ||
                _('No tailnet');
            this._accountsSubMenu.label.text = _fmt(
                _('Tailnet: %s'),
                currentLabel,
            );

            // Without operator (typically right after a logout, where the
            // pref went away with the discarded profile) offer the one-click
            // re-grant up front. The account rows below still work in that
            // state (the client elevates the switch itself), so this is a
            // shortcut to full control, not a prerequisite.
            if (!snap.canControl)
                sub.addMenuItem(this._makeOperatorRow());

            if (snap.accounts.length === 0) {
                if (snap.accountName) {
                    const row = new PeerRow({
                        title: snap.accountName,
                        checked: true,
                    });
                    row.reactive = false;
                    sub.addMenuItem(row);
                }
            } else {
                // Sort alphabetically so the order is stable across refreshes
                // (tailscale switch --list output order is not guaranteed).
                const sorted = [...snap.accounts].sort((a, b) =>
                    tailnetTitle(a).localeCompare(tailnetTitle(b)),
                );
                for (const acc of sorted) {
                    const label = tailnetTitle(acc);
                    sub.addMenuItem(
                        new PeerRow({
                            title: label,
                            subtitle: _accountSubtitle(acc),
                            checked: acc.current,
                            onClick: () => {
                                if (acc.current) return;
                                Notifier.withFeedback(
                                    Category.PROFILE_SWITCH,
                                    _fmt(_('Switching to %s'), label),
                                    _fmt(_('Active tailnet: %s'), label),
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
                style_class: 'tailscale-bottom-row',
            });
            const authBox = new St.BoxLayout({
                x_expand: true,
                style_class: 'tailscale-bottom-buttons',
            });
            authRow.add_child(authBox);

            const loginBtn = new St.Button({
                label: _('Login'),
                x_expand: true,
                style_class: 'button',
            });
            loginBtn.connect('clicked', () => {
                this._closeAllMenus();
                Notifier.withFeedback(
                    Category.ACCOUNT,
                    _('Opening Tailscale login'),
                    _('Login flow started'),
                    () => this._client.login(),
                );
            });
            authBox.add_child(loginBtn);

            if (!snap.loggedOut) {
                const logoutBtn = new St.Button({
                    label: _('Logout'),
                    x_expand: true,
                    style_class: 'button',
                });
                logoutBtn.connect('clicked', () => {
                    this._closeAllMenus();
                    Notifier.withFeedback(
                        Category.ACCOUNT,
                        _('Logging out'),
                        _('Logged out'),
                        () => this._client.logout(),
                    );
                });
                authBox.add_child(logoutBtn);
            }
            sub.addMenuItem(authRow);
        }

        /* --------------------------- Features ----------------------------- */

        // Trim the rendered menu down to what this tailnet's ACL allows.
        // Called after the main render pass has marked all items visible.
        // The Send/Funnel separator hides when both halves of its block are
        // off so we don't get an orphan divider.
        //
        // Read off the snapshot, so a grant or a revocation lands on the
        // next poll like every other fact about the tailnet. `null` (a
        // daemon that publishes no capability map) is not a refusal, and
        // hiding a feature we cannot rule out would be worse than offering
        // one the control plane goes on to decline.
        //
        // Nothing else is gated: exit nodes, Magic DNS, routes, shields and
        // SSH are always shown, because whether they are useful is the
        // daemon's business, not a setting.
        _applyFeatureGates(snap) {
            const taildrop = snap.taildropAvailable !== false;
            const funnels  = snap.funnelsAvailable !== false;
            this._acceptFilesRow.visible  &&= taildrop;
            // The two buttons share one row, so each is hidden on its own
            // and the row goes only when both are: a tailnet that allows
            // one of the pair still gets that one, full width.
            this._sendFileBtn.visible      = taildrop;
            this._funnelBtn.visible        = funnels;
            this._transferRow.visible     &&= (taildrop || funnels);
            this._funnelSeparator.visible &&= (taildrop || funnels);
        }

        /* --------------------------- Taildrop ----------------------------- */

        // The gsetting is the single source of truth: extension.js watches
        // `taildrop-accept` and drives the receiver process from it (gated
        // on Taildrop availability too). Writing the bool here is therefore
        // the whole action: calling client.setAcceptFiles() as well would
        // start the receiver a second time and skip that availability gate.
        _setAcceptFiles(value) {
            this._settings.set_boolean('taildrop-accept', !!value);
            Notifier.notify({
                category: Category.TAILDROP,
                level: 'success',
                message: value
                    ? _('Accepting Taildrop files')
                    : _('Taildrop receiver stopped'),
            });
        }

        // Send flow: straight to the dialog, which owns the selection and
        // opens the portal chooser itself, once per kind, because no single
        // chooser yields files and folders together. Paths may also arrive
        // pre-selected from the Nautilus D-Bus call, in which case they are
        // simply what the dialog starts with. Peers come from
        // `tailscale file cp --targets`, which only lists nodes that can
        // actually receive Taildrop files.
        async runSendFlow(preselectedFiles) {
            // Reachable with the menu closed and its rows hidden: the
            // keybinding fires from anywhere, and Nautilus calls straight
            // in over D-Bus. Without this the peer listing comes back
            // empty and the user is told there is nobody online, which is
            // the wrong problem.
            if (!requireBackend(this._client.snapshot, Category.TAILDROP))
                return;
            const { targets, denied } = await this._client.fileTargets();
            if (denied) {
                Notifier.notify({
                    category: Category.TAILDROP,
                    level: 'error',
                    message: _('Taildrop is disabled for this tailnet by your admin.'),
                });
                return;
            }
            const online = targets.filter((t) => !t.offline);
            if (online.length === 0) {
                Notifier.notify({
                    category: Category.TAILDROP,
                    level: 'error',
                    message: _('No online peers available to receive files'),
                });
                return;
            }

            this._showDialog(new SendFileDialog({
                extension: this._extension,
                paths: preselectedFiles ?? [],
                peers: online,
                pickFiles: (title, directory) =>
                    this._pickFiles(title, directory),
                onPick: (picked, opts) => {
                    if (!picked || picked.length === 0) return;
                    this._sendTo(picked, opts.files, opts);
                },
            }));
        }

        // Archive first when asked, then hand the result to Taildrop. The
        // temp directory is removed on every exit path, including a failed
        // send, so a cancelled or rejected transfer never leaves the
        // archive (possibly an encrypted one) sitting in /tmp.
        async _sendTo(peers, files, { asZip, password }) {
            const label = files.length === 1
                ? files[0].split('/').pop()
                : _fmt(_('%d files'), files.length);
            const where = peers.length === 1
                ? peers[0].host
                : _fmt(_('%d devices'), peers.length);

            // One transfer per recipient: `tailscale file cp` takes a single
            // target. Sequential rather than parallel: the daemon serialises
            // them anyway, and one failure then still leaves the rest sent.
            const fanOut = async (paths) => {
                let sent = 0;
                let firstError = '';
                for (const peer of peers) {
                    const r = await this._client.sendFile(peer.ip, paths);
                    if (r?.ok === false)
                        firstError ||= r.message || '';
                    else
                        sent++;
                }
                if (sent === peers.length) return { ok: true };
                if (sent === 0) {
                    return {
                        ok: false,
                        message: firstError ||
                            _fmt(_('Could not send to %s'), where),
                    };
                }
                return {
                    ok: false,
                    message: _fmt(
                        _('Sent to %d of %d devices'), sent, peers.length),
                };
            };

            // The success line names the file too: it outlives the transfer
            // in the notification history, where "Sent to redmi" alone says
            // nothing about which of the evening's transfers it was. When
            // zipping, what lands on the other device is one archive, so
            // that is what gets named: "Sent 3 files" would describe
            // something the recipient never receives, and would not match
            // the name they have to look for. Settled up front, before the
            // archive exists, so the message can be written now.
            const archiveName = asZip ? archiveName() : null;
            const sentMsg = _fmt(_('Sent %s to %s'), archiveName ?? label, where);

            if (!asZip) {
                await Notifier.withFeedback(
                    Category.TAILDROP,
                    _fmt(_('Sending %s to %s'), label, where),
                    sentMsg,
                    () => fanOut(files),
                );
                return;
            }

            await Notifier.withFeedback(
                Category.TAILDROP,
                _fmt(_('Archiving %s'), label),
                sentMsg,
                async () => {
                    // Built once and reused: the archive is byte-identical
                    // for every recipient, and zipping per target would pay
                    // the cost (and the encryption) N times over.
                    const archive =
                        await makeArchive(files, password, archiveName);
                    if (!archive) {
                        return {
                            ok: false,
                            message: _('Could not create the archive'),
                        };
                    }
                    try {
                        return await fanOut([archive.path]);
                    } finally {
                        removeTree(Gio.File.new_for_path(archive.dir));
                    }
                },
            );
        }

        // Open a ModalDialog while keeping a handle so destroy() can tear
        // it down if the extension is disabled with the dialog still up.
        _showDialog(dialog) {
            this._openDialog = dialog;
            dialog.connect('closed', () => {
                if (this._openDialog === dialog) this._openDialog = null;
            });
            dialog.open();
        }

        // Native multi-file picker via the XDG Desktop Portal
        // (org.freedesktop.portal.FileChooser), plain D-Bus on the session
        // bus, no subprocess. Resolves with absolute paths, or null when
        // the user cancels or the portal is unavailable. The Response
        // signal subscription is tracked on the toggle so destroy() can
        // drop it if the picker outlives the extension.
        _pickFiles(title, directory = false) {
            return new Promise((resolve) => {
                const bus = Gio.DBus.session;
                const token = `tailscale_gnome_${GLib.random_int()}`;
                const sender = bus.get_unique_name().slice(1).replace(/\./g, '_');
                const requestPath =
                    `/org/freedesktop/portal/desktop/request/${sender}/${token}`;

                const finish = (paths) => {
                    if (this._portalSubId) {
                        bus.signal_unsubscribe(this._portalSubId);
                        this._portalSubId = 0;
                    }
                    resolve(paths);
                };

                this._portalSubId = bus.signal_subscribe(
                    'org.freedesktop.portal.Desktop',
                    'org.freedesktop.portal.Request',
                    'Response',
                    requestPath,
                    null,
                    Gio.DBusSignalFlags.NONE,
                    (_conn, _sender, _path, _iface, _signal, params) => {
                        const [response, results] = params.recursiveUnpack();
                        if (response !== 0 || !Array.isArray(results.uris)) {
                            finish(null);
                            return;
                        }
                        const paths = [];
                        for (const uri of results.uris) {
                            try {
                                paths.push(GLib.filename_from_uri(uri)[0]);
                            } catch {
                                // Non-local URI (remote mount): skip it.
                            }
                        }
                        finish(paths.length > 0 ? paths : null);
                    },
                );

                bus.call(
                    'org.freedesktop.portal.Desktop',
                    '/org/freedesktop/portal/desktop',
                    'org.freedesktop.portal.FileChooser',
                    'OpenFile',
                    new GLib.Variant('(ssa{sv})', ['', title, {
                        handle_token: new GLib.Variant('s', token),
                        // `directory` selects folders *instead of* files,
                        // never both: the portal has no mixed mode and GTK4
                        // froze the split into separate GtkFileDialog
                        // methods (xdg-desktop-portal discussion #1419).
                        // Worse, in folder mode picking a file inside a
                        // folder returns the folder. Hence two trips, one
                        // per kind, with SendFileDialog accumulating both.
                        multiple: new GLib.Variant('b', true),
                        directory: new GLib.Variant('b', directory),
                    }]),
                    new GLib.VariantType('(o)'),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (conn, res) => {
                        let handle;
                        try {
                            [handle] = conn.call_finish(res).deep_unpack();
                        } catch {
                            // Portal missing or call rejected: no picker.
                            Notifier.notify({
                                category: Category.ERRORS,
                                level: 'error',
                                message: _('File chooser portal unavailable'),
                            });
                            finish(null);
                            return;
                        }
                        // Modern portals honour handle_token, so the handle
                        // matches the path we subscribed to. A pre-2017
                        // portal would return a different handle; treat that
                        // as a cancel rather than juggling a resubscribe.
                        if (handle !== requestPath) finish(null);
                    },
                );
            });
        }

        /* --------------------------- helpers ------------------------------ */

        // Close both the toggle's secondary menu AND the parent Quick
        // Settings panel. Plain `this.menu.close()` only closes the former,
        // leaving the QS popup hanging on top of any modal we open next.
        _closeAllMenus() {
            this.menu.close();
            const qs = Main.panel.statusArea.quickSettings;
            if (qs.menu.isOpen) qs.menu.close();
        }

        // An inbound Taildrop file. The wording is built here rather than in
        // the client so it can be translated.
        _notifyFileReceived(path, size) {
            const name = path.split('/').pop();
            const human = GLib.format_size(size);
            Notifier.notify({
                category: Category.TAILDROP,
                level: 'success',
                spontaneous: true,
                message: _fmt(_('Received %s (%s) - click to open'), name, human),
                onActivate: () => _showInFileManager(path),
            });
        }

        _copyToClipboard(text) {
            if (!text) return;
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD,
                text,
            );
            Notifier.notify({
                category: Category.MISC,
                level: 'success',
                message: _fmt(_('Copied %s to clipboard'), text),
            });
        }

        destroy() {
            if (this._raiseTimeoutId) {
                GLib.source_remove(this._raiseTimeoutId);
                this._raiseTimeoutId = 0;
            }
            if (this._portalSubId) {
                Gio.DBus.session.signal_unsubscribe(this._portalSubId);
                this._portalSubId = 0;
            }
            if (this._openDialog) {
                this._openDialog.destroy();
                this._openDialog = null;
            }
            // destroy() is not close(), so the 'closed' handler that
            // normally clears this never runs. Dropped by hand rather than
            // left pointing at a destroyed actor.
            this._funnelsDialog = null;
            if (this._menuStateId) {
                this.menu.disconnect(this._menuStateId);
                this._menuStateId = 0;
            }
            this._client.disconnectObject(this);
            this._settings.disconnectObject(this);
            this.disconnectObject(this);
            super.destroy();
        }
    },
);
