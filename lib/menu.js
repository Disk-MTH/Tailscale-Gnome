// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// QuickMenuToggle for Tailscale. The whole menu is rebuilt from the
// client's snapshot on every 'state-changed'. The body toggle uses
// toggleMode: true so `this.checked` flips synchronously on click; the
// next poll snaps it back if the action couldn't actually run.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {
    gettext as _, ngettext,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import { Notifier, Category } from './notify.js';
import {
    fmt as _fmt, gicon as _gicon, showInFileManager as _showInFileManager,
} from './util.js';

const TAILSCALE_ADMIN_URL = 'https://login.tailscale.com/admin/machines';

const ICON_ACTIVE = 'tailscale-symbolic';
const ICON_DISABLED = 'tailscale-disabled-symbolic';
// Everything but the Tailscale logo comes from the user's icon theme, so
// the menu matches whatever the rest of their desktop looks like.
const ICON_COPY = 'edit-copy-symbolic';
// Identifies the self row in _openCopyKey, alongside the peers' dnsName.
const SELF_COPY_KEY = '\u0000self';
const ICON_TRASH = 'user-trash-symbolic';

// Clutter opacity, 0-255, for a control that is on screen but cannot be
// operated — currently the "Send as zip" switch while a folder pins it on.
const LOCKED_OPACITY = 115;

// Heading for the in-shell dialogs: the Tailscale mark, then the title.
// Both dialogs are raised over whatever the user was doing, so the mark is
// what says at a glance which extension is asking.
function _dialogTitle(extension, text) {
    const row = new St.BoxLayout({
        style_class: 'tailscale-dialog-heading',
        x_expand: true,
    });
    row.add_child(new St.Icon({
        gicon: _gicon(extension, ICON_ACTIVE),
        icon_size: 20,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    row.add_child(new St.Label({
        style_class: 'tailscale-send-title',
        text,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    return row;
}

// The right-side status pill used by every row that carries one (submenu
// headers, InfoRow, ToggleRow). One factory so they can never drift apart.
function _makePill() {
    return new St.Label({
        style_class: 'tailscale-status-pill',
        y_align: Clutter.ActorAlign.CENTER,
    });
}

// The small online/offline dot. Colours live in the stylesheet so they
// follow the theme instead of being frozen into an inline style.
function _makeStatusDot(online) {
    return new St.Label({
        text: online ? '●' : '○',
        style_class: `tailscale-peer-dot ${online ? 'online' : 'offline'}`,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

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

/**
 * Build the copy control shared by the self row and every peer row.
 *
 * A node worth copying has two identities — its Tailscale IP and its Magic
 * DNS name — and only the user knows which one they are about to paste. So
 * a single target copies straight away, while two or more expand a chooser
 * under the row rather than guessing.
 *
 * `open` and `onToggle` exist because the rows holding this control are
 * torn down and rebuilt on every state change. Without a key the caller
 * can restore, an expanded chooser would silently fold itself away the
 * moment a peer went online somewhere else in the tailnet.
 *
 * @param {{iconName: string, targets: {label: string, value: string}[],
 *          onCopy: (value: string) => void, open?: boolean,
 *          onToggle?: (open: boolean) => void}} opts
 * @returns {{button: St.Button, chooser: St.BoxLayout}}
 */
function _makeCopyControl({ iconName, targets, onCopy, open = false, onToggle }) {
    // x_align END keeps the choices tucked under the button that opened
    // them; the entries stay at their natural width rather than stretching
    // across the row, so they read as a menu and not as two more rows.
    const chooser = new St.BoxLayout({
        vertical: true,
        x_expand: true,
        x_align: Clutter.ActorAlign.END,
        style_class: 'tailscale-copy-chooser',
        visible: false,
    });
    const button = new St.Button({
        style_class: 'button tailscale-icon-btn',
        child: new St.Icon({ icon_name: iconName, icon_size: 16 }),
        y_align: Clutter.ActorAlign.CENTER,
        can_focus: true,
        accessible_name: _('Copy'),
    });

    if (targets.length === 1) {
        const [only] = targets;
        button.connect('clicked', () => onCopy(only.value));
        return { button, chooser };
    }

    for (const target of targets) {
        const choice = new St.Button({
            style_class: 'tailscale-copy-choice',
            label: target.label,
            x_expand: false,
            x_align: Clutter.ActorAlign.END,
            can_focus: true,
        });
        choice.connect('clicked', () => {
            chooser.visible = false;
            onCopy(target.value);
        });
        chooser.add_child(choice);
    }
    chooser.visible = open;
    button.connect('clicked', () => {
        chooser.visible = !chooser.visible;
        onToggle?.(chooser.visible);
    });
    return { button, chooser };
}

/**
 * What is worth copying for a node, most-used first.
 *
 * The Magic DNS name is only offered when Magic DNS is actually on: with it
 * off the name resolves nowhere, so pasting it would hand the user a string
 * that silently fails.
 *
 * @param {{ip: string, name: string, magicDNS: boolean}} opts
 * @returns {{label: string, value: string}[]}
 */
function _copyTargetsFor({ ip, name, magicDNS }) {
    const targets = [];
    if (ip) targets.push({ label: _('Copy IP'), value: ip });
    if (magicDNS && name && name !== ip)
        targets.push({ label: _fmt(_('Copy %s'), name), value: name });
    return targets;
}

/**
 * Whether a password can safely be handed to `zip`.
 *
 * The passphrase travels in ZIPOPT rather than argv, because /proc's
 * cmdline is world-readable while environ is not: a password on the
 * command line would be visible to every local user for as long as the
 * archive takes to build. zip parses ZIPOPT by splitting on whitespace,
 * so a password containing any is the one thing that cannot be carried
 * this way — and silently falling back to argv would trade the user's
 * secret for their convenience without telling them.
 *
 * @param {string} password
 * @returns {boolean}
 */
export function isUsablePassword(password) {
    return password.length > 0 && !/\s/.test(password);
}

function _queryInfo(file) {
    return new Promise((resolve) => {
        file.query_info_async(
            'standard::type,standard::size,standard::is-symlink',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_LOW, null,
            (f, res) => {
                try {
                    resolve(f.query_info_finish(res));
                } catch {
                    resolve(null);  // vanished, or not ours to read
                }
            });
    });
}

function _enumerate(dir) {
    return new Promise((resolve) => {
        dir.enumerate_children_async(
            'standard::name,standard::type,standard::size,standard::is-symlink',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            GLib.PRIORITY_LOW, null,
            (d, res) => {
                try {
                    resolve(d.enumerate_children_finish(res));
                } catch {
                    resolve(null);
                }
            });
    });
}

function _nextFiles(enumerator) {
    return new Promise((resolve) => {
        enumerator.next_files_async(
            64, GLib.PRIORITY_LOW, null,
            (e, res) => {
                try {
                    resolve(e.next_files_finish(res));
                } catch {
                    resolve([]);
                }
            });
    });
}

/**
 * Weigh one selected path: the bytes it would put on the wire, and whether
 * it holds anything worth sending at all.
 *
 * Both facts come from a single walk because the dialog needs them
 * together — an empty folder must not enable Send, and its size line must
 * not read as if it would. Every step is async at low priority: a deep
 * tree measured synchronously would stall the compositor, and this runs
 * while the user is still looking at the dialog.
 *
 * Symlinks are counted at their own (tiny) size and never followed, so a
 * loop cannot hang the walk and a link into / cannot silently make the
 * selection look enormous.
 *
 * @param {string} path absolute file or directory
 * @returns {Promise<{isDir: boolean, size: number, fileCount: number}>}
 */
async function _measurePath(path) {
    const root = Gio.File.new_for_path(path);
    const info = await _queryInfo(root);
    if (!info)
        return { isDir: false, size: 0, fileCount: 0 };
    if (info.get_file_type() !== Gio.FileType.DIRECTORY)
        return { isDir: false, size: info.get_size(), fileCount: 1 };

    let size = 0;
    let fileCount = 0;
    // Explicit stack rather than recursion: the depth of a user's folder is
    // not something to trust a JS call stack with.
    const pending = [root];
    while (pending.length > 0) {
        const dir = pending.pop();
        const enumerator = await _enumerate(dir);
        if (!enumerator) continue;
        for (;;) {
            const batch = await _nextFiles(enumerator);
            if (!batch || batch.length === 0) break;
            for (const child of batch) {
                if (child.get_file_type() === Gio.FileType.DIRECTORY &&
                    !child.get_is_symlink()) {
                    pending.push(dir.get_child(child.get_name()));
                } else {
                    size += child.get_size();
                    fileCount++;
                }
            }
        }
    }
    return { isDir: true, size, fileCount };
}

/**
 * Zip `paths` into a fresh temp directory and resolve with the archive
 * path, or null if zip is missing or fails.
 *
 * Entries are added by basename from their own parent directory, so the
 * archive carries "photos/a.jpg" rather than "/home/me/photos/a.jpg".
 *
 * @param {string[]} paths absolute files and/or directories
 * @param {string} password empty for no encryption
 * @param {string} name basename to give the archive, from `_archiveName`
 * @returns {Promise<{dir: string, path: string}|null>}
 */
async function _makeArchive(paths, password, name) {
    let dir;
    try {
        dir = GLib.dir_make_tmp('tailscale-taildrop-XXXXXX');
    } catch {
        return null;
    }

    const archive = GLib.build_filenamev([dir, name]);

    for (const p of paths) {
        const ok = await new Promise((resolve) => {
            let proc;
            try {
                const launcher = new Gio.SubprocessLauncher({
                    flags: Gio.SubprocessFlags.STDOUT_SILENCE |
                           Gio.SubprocessFlags.STDERR_PIPE,
                });
                launcher.set_cwd(GLib.path_get_dirname(p));
                if (password)
                    launcher.setenv('ZIPOPT', `-P${password}`, true);
                proc = launcher.spawnv([
                    'zip', '-q', '-r', archive, GLib.path_get_basename(p),
                ]);
            } catch {
                resolve(false);
                return;
            }
            proc.wait_check_async(null, (obj, res) => {
                try {
                    resolve(obj.wait_check_finish(res));
                } catch {
                    resolve(false);
                }
            });
        });
        if (!ok) {
            _removeTree(Gio.File.new_for_path(dir));
            return null;
        }
    }
    return { dir, path: archive };
}

// Name for a Taildrop archive: a timestamp, and nothing else. Naming it
// after the first entry made every archive look like that one file, which
// is misleading when it holds four unrelated things and unhelpful on the
// receiving end, where several such sends pile up in one folder. A
// timestamp sorts, never collides within a second, and says what it is.
function _archiveName() {
    const stamp = GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S');
    return `taildrop-${stamp}.zip`;
}

// Depth-first delete. The temp directory holds exactly one archive we
// created, so this never walks anything the user owns.
function _removeTree(file) {
    try {
        const en = file.enumerate_children(
            'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)) !== null) {
            const child = file.get_child(info.get_name());
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                _removeTree(child);
            else child.delete(null);
        }
    } catch {
        // Not a directory, or already gone.
    }
    try {
        file.delete(null);
    } catch {
        // Best effort: a leftover in /tmp is not worth surfacing.
    }
}

/**
 * A funnel's ports as "external:internal", the order `docker -p` uses, so
 * the mapping reads the same way here as it does everywhere else.
 *
 * Falls back to the public port alone when the target carries no port of
 * its own — a funnel can serve static text or a file path rather than
 * proxying a local listener.
 *
 * @param {{httpsPort: number, target: string}} f
 * @returns {string}
 */
function _funnelPorts(f) {
    const m = /:(\d+)\s*$/.exec(f.target || '');
    return m ? `${f.httpsPort}:${m[1]}` : String(f.httpsPort);
}

/**
 * The public address a funnel serves. 443 is left off because it is what a
 * browser assumes for https — printing it would make the two identical
 * addresses look like two different ones.
 *
 * @param {{host: string, httpsPort: number}} f
 * @returns {string}
 */
function _funnelUrl(f) {
    return `https://${f.host}${f.httpsPort === 443 ? '' : `:${f.httpsPort}`}`;
}

// Decorate a PopupSubMenuMenuItem with a right-side pill, inserted between
// the title label and the dropdown arrow. Returns the pill so callers can
// update it later.
function _decorateWithPill(submenuItem) {
    submenuItem.label.x_expand = true;
    submenuItem.label.y_align = Clutter.ActorAlign.CENTER;
    const pill = _makePill();
    pill.visible = false;
    if (submenuItem._triangleBin)
        submenuItem.insert_child_below(pill, submenuItem._triangleBin);
    else submenuItem.add_child(pill);
    return pill;
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

// This project's status vocabulary: what the Quick Settings pill shows for
// a snapshot that isn't cleanly "running". Exported so extension.js's
// watcher-copy table can reuse it for the connection-ended notification
// (a Starting phase that resolved to something other than Running) instead
// of duplicating these five lines and letting the two drift apart.
export function statusText(snap) {
    if (snap.error) return _('Tailscale unavailable');
    if (snap.loggedOut) return _('Logged out');
    if (snap.backendState === 'NeedsLogin') return _('Login required');
    if (snap.running) return snap.accountName || _('Connected');
    return _('Disconnected');
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

/* -------------------------------------------------------------------------- */
/*                              Helper widgets                                */
/* -------------------------------------------------------------------------- */

const InfoRow = GObject.registerClass(
    class InfoRow extends PopupMenu.PopupBaseMenuItem {
        _init(text, accessory = null, opts = {}) {
            super._init({
                reactive: false,
                style_class: opts.styleClass ?? '',
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
                this._accessory = _makePill();
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
                if (this._accessory) this._accessory.text = '';
                return;
            }
            if (!this._accessory) {
                this._accessory = _makePill();
                this.add_child(this._accessory);
            }
            this._accessory.text = text;
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
            this.setOrnament(PopupMenu.Ornament.NONE);

            // Same right-side pill as the other submenu headers.
            this._pill = _decorateWithPill(this);

            // Make the triangle bin intercept clicks independently so clicking
            // the triangle opens the submenu while clicking the label area
            // toggles the setting.
            if (this._triangleBin) {
                this._triangleBin.reactive = true;
                this._triangleBin.track_hover = true;
                this._triangleBin.connectObject('button-press-event', () => {
                    this.menu.toggle();
                    return Clutter.EVENT_STOP;
                }, this);
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
            this._pill.text = text || '';
            this._pill.visible = !!text;
        }
    },
);

// Peer/account/exit-node row. Override activate() so clicking does NOT emit
// 'activate' and therefore does NOT close the parent QuickSettings panel.
const PeerRow = GObject.registerClass(
    class PeerRow extends PopupMenu.PopupBaseMenuItem {
        _init({
            title, subtitle, online, checked, onClick, styleClass,
            onCopy, copyIconName, copyTargets = [], copyOpen = false,
            onCopyToggle,
        }) {
            super._init({ style_class: styleClass ?? '' });
            this._onClick = onClick;

            // Everything stacks vertically so the copy chooser can unfold
            // directly beneath the row it belongs to.
            const outer = new St.BoxLayout({ vertical: true, x_expand: true });
            const line = new St.BoxLayout({
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });

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
                        style_class: 'tailscale-peer-ip',
                    }),
                );
            }
            line.add_child(box);

            if (online !== undefined) {
                line.add_child(_makeStatusDot(online));
                if (!online)
                    this.add_style_class_name('tailscale-peer-offline');
            }

            if (onCopy && copyTargets.length > 0) {
                const { button, chooser } = _makeCopyControl({
                    iconName: copyIconName,
                    targets: copyTargets,
                    onCopy,
                    open: copyOpen,
                    onToggle: onCopyToggle,
                });
                line.add_child(button);
                outer.add_child(line);
                outer.add_child(chooser);
            } else {
                outer.add_child(line);
            }
            this.add_child(outer);

            this.setOrnament(
                checked ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE,
            );
        }

        activate(_event) {
            this._onClick?.();
        }
    },
);

// This device, rendered exactly like a peer: Magic DNS name on top, IP
// underneath, same copy control. It is a long-lived row rather than one
// rebuilt per render (the toggle keeps a reference for visibility gating),
// so the parts that change are torn down and rebuilt inside update().
const SelfRow = GObject.registerClass(
    class SelfRow extends PopupMenu.PopupBaseMenuItem {
        _init() {
            // reactive:true on purpose. PopupBaseMenuItem stamps
            // `popup-inactive-menu-item` on non-reactive items, and the
            // shell theme dims everything inside them — which greyed out
            // the device name, its IP and the copy choices alike. Clicking
            // still does nothing: activate() below is a no-op.
            super._init({ reactive: true });

            this._outer = new St.BoxLayout({ vertical: true, x_expand: true });
            this._line = new St.BoxLayout({
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const text = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._title = new St.Label({ text: '' });
            this._subtitle = new St.Label({
                text: '',
                style_class: 'tailscale-peer-ip',
            });
            text.add_child(this._title);
            text.add_child(this._subtitle);
            this._line.add_child(text);

            this._dot = _makeStatusDot(false);
            this._line.add_child(this._dot);

            this._outer.add_child(this._line);
            this.add_child(this._outer);

            this._copyButton = null;
            this._chooser = null;
        }

        /**
         * @param {{title: string, subtitle: string, online: boolean,
         *          copyIconName: string,
         *          copyTargets: {label: string, value: string}[],
         *          onCopy: (value: string) => void}} opts
         */
        update({
            title, subtitle, online, copyIconName, copyTargets, onCopy,
            copyOpen = false, onCopyToggle,
        }) {
            this._title.text = title;
            this._subtitle.text = subtitle;
            this._subtitle.visible = !!subtitle;

            this._dot.text = online ? '●' : '○';
            this._dot.remove_style_class_name(online ? 'offline' : 'online');
            this._dot.add_style_class_name(online ? 'online' : 'offline');

            // The chooser's contents depend on the current IP and Magic DNS
            // state, so rebuild rather than patch: a stale entry here would
            // copy an address the device no longer has.
            this._copyButton?.destroy();
            this._chooser?.destroy();
            this._copyButton = null;
            this._chooser = null;
            if (copyTargets.length === 0) return;

            const { button, chooser } = _makeCopyControl({
                iconName: copyIconName,
                targets: copyTargets,
                onCopy,
                open: copyOpen,
                onToggle: onCopyToggle,
            });
            this._copyButton = button;
            this._chooser = chooser;
            this._line.add_child(button);
            this._outer.add_child(chooser);
        }

        activate(_event) {
            // No-op: clicking the row body must not close the menu.
        }
    },
);

/* -------------------------------------------------------------------------- */
/*                           Taildrop send dialog                             */
/* -------------------------------------------------------------------------- */

// The whole send flow, in one modal. No file chooser runs before it,
// because no chooser can produce the selection this needs: the portal's
// `directory` option picks folders *instead of* files, never both
// (xdg-desktop-portal discussion #1419), and GTK4 froze that split into
// separate GtkFileDialog methods. So the dialog owns the selection and
// grows it through two chooser trips, one per kind, and the user sees
// what they have accumulated in between.
//
// Peer rows toggle rather than send on click: one file set often has to
// reach several devices, and a stray click on a list should not start a
// transfer.
const SendFileDialog = GObject.registerClass(
    class SendFileDialog extends ModalDialog.ModalDialog {
        _init({ extension, paths = [], peers, pickFiles, onPick }) {
            super._init({ styleClass: 'tailscale-send-dialog' });
            this._onPick = onPick;
            this._pickFiles = pickFiles;
            this._resolved = false;
            this._asZip = false;
            this._password = '';
            // Keyed by path so the same folder added twice counts once.
            // Insertion-ordered, so the table reads in the order things
            // were added and the archive keeps that order too.
            this._entries = new Map();
            // Insertion-ordered for the same reason: recipients are sent to
            // in the order they were ticked, and the reports follow.
            this._selected = new Set();
            this._sendButton = null;
            this._picking = false;

            this.contentLayout.add_child(
                _dialogTitle(extension, _('Send via Taildrop')));

            this._buildZipControls();
            this._buildSelection();

            // One line instead of two: the tally and the "send to" lead-in
            // read as a single sentence — "Send 4 items (9.8 MB) to" — so
            // the recipient list below is what it points at.
            this._sendToLabel = new St.Label({
                style_class: 'tailscale-send-subtitle',
                text: _('Send to:'),
            });
            this.contentLayout.add_child(this._sendToLabel);

            const scroll = new St.ScrollView({
                style_class: 'tailscale-send-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true,
            });
            const list = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'tailscale-send-list',
            });
            scroll.set_child(list);
            this.contentLayout.add_child(scroll);

            for (let i = 0; i < peers.length; i++) {
                if (i > 0) {
                    list.add_child(new St.Widget({
                        style_class: 'tailscale-send-separator',
                        height: 1,
                        x_expand: true,
                    }));
                }
                list.add_child(this._makePeerRow(peers[i]));
            }

            this.setButtons([
                {
                    label: _('Cancel'),
                    action: () => this._finish([]),
                    key: Clutter.KEY_Escape,
                },
            ]);
            // Kept so the send action can be greyed out until the dialog
            // holds something to send and someone to send it to: Dialog
            // checks `button.reactive` before firing, both on click and on
            // the Return binding that `default: true` installs.
            this._sendButton = this.addButton({
                label: _('Send'),
                action: () => this._send(),
                default: true,
            });

            // St has no tooltips, so the full path of a hovered row shows in
            // a label of our own. It lives outside the dialog's layout —
            // inside it, appearing would resize the dialog under the pointer.
            this._pathTip = new St.Label({
                style_class: 'tailscale-path-tip',
                visible: false,
            });
            Main.layoutManager.uiGroup.add_child(this._pathTip);
            this.connect('destroy', () => {
                this._pathTip?.destroy();
                this._pathTip = null;
            });

            this._renderSelection();
            if (paths.length > 0)
                this._addPaths(paths);
        }

        /* ----------------------------- path tip --------------------------- */

        _showPathTip(row, path) {
            if (!this._pathTip) return;
            this._pathTip.text = path;
            this._pathTip.show();
            // Asked for rather than read off `width`: the label has not been
            // allocated at its new text yet, so `width` is the previous
            // path's.
            const [, width] = this._pathTip.get_preferred_width(-1);
            const [rx, ry] = row.get_transformed_position();
            let x = rx;
            const monitor = Main.layoutManager.currentMonitor;
            if (monitor)
                x = Math.max(monitor.x, Math.min(x, monitor.x + monitor.width - width));
            this._pathTip.set_position(
                Math.round(x), Math.round(ry + row.height + 2));
        }

        _hidePathTip() {
            this._pathTip?.hide();
        }

        /* ------------------------------- zip ------------------------------ */

        // "Send as zip" plus an optional password. Taildrop moves plain
        // files, so a directory can only travel as an archive — the switch
        // is then forced on and locked rather than offering a choice that
        // would fail.
        _buildZipControls() {
            const box = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'tailscale-send-options',
            });

            // The whole row is the button and the switch is inert render:
            // Switch drives itself from a PanGesture, so leaving it reactive
            // inside a button would toggle twice on a click that landed on
            // the switch and once on a click that did not.
            const zipButton = new St.Button({
                style_class: 'tailscale-send-row tailscale-zip-row',
                can_focus: true,
                x_expand: true,
            });
            const zipRow = new St.BoxLayout({
                x_expand: true,
            });
            const zipText = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._zipTitle = new St.Label({ text: _('Send as zip') });
            zipText.add_child(this._zipTitle);
            this._zipForcedLabel = new St.Label({
                text: _('Required: the selection contains a folder'),
                style_class: 'tailscale-peer-ip',
            });
            this._zipForcedLabel.visible = false;
            zipText.add_child(this._zipForcedLabel);
            zipRow.add_child(zipText);

            // The shell's own switch, so it reads as a setting rather than
            // as another list row that happens to be ticked.
            this._zipSwitch = new PopupMenu.Switch(false);
            this._zipSwitch.reactive = false;
            this._zipSwitch.connect('notify::state', () => {
                this._asZip = this._zipSwitch.state;
                this._pwBox.visible = this._asZip;
            });
            zipRow.add_child(this._zipSwitch);
            zipButton.set_child(zipRow);
            zipButton.connect('clicked', () => this._zipSwitch.toggle());
            this._zipButton = zipButton;
            box.add_child(zipButton);

            this._pwBox = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'tailscale-send-password',
            });
            const pwEntry = new St.Entry({
                style_class: 'tailscale-port-entry',
                hint_text: _('Password (optional)'),
                can_focus: true,
                x_expand: true,
            });
            pwEntry.clutter_text.set_password_char('●');
            const pwHint = new St.Label({
                text: _('Spaces are not allowed in the password'),
                style_class: 'tailscale-peer-ip tailscale-send-hint',
            });
            pwHint.visible = false;
            this._pwBox.add_child(pwEntry);
            this._pwBox.add_child(pwHint);
            this._pwBox.visible = false;
            box.add_child(this._pwBox);

            pwEntry.clutter_text.connect('text-changed', () => {
                const text = pwEntry.get_text();
                // An unusable password is treated as none rather than
                // quietly encrypting with a mangled one.
                this._password = isUsablePassword(text) ? text : '';
                pwHint.visible = text.length > 0 && !isUsablePassword(text);
            });

            this.contentLayout.add_child(box);
        }

        // A folder in the selection pins the switch on; removing the last
        // one hands the choice back rather than leaving it stuck.
        _syncZip() {
            const hasDir = [...this._entries.values()].some((e) => e.isDir);
            if (hasDir === this._zipLocked) return;
            this._zipLocked = hasDir;
            this._zipForcedLabel.visible = hasDir;
            this._zipButton.reactive = !hasDir;
            this._zipButton.can_focus = !hasDir;
            // A dead control has to look dead. `reactive = false` alone
            // changes nothing on screen: the switch keeps its full-strength
            // accent fill and still invites a click. The dimming is set on
            // the actors rather than through a style class, because the
            // switch is not an St.Label and CSS opacity did not reach it —
            // Clutter opacity does, and it carries down to the handle and
            // the on/off glyphs with it. The reason line is left alone: it
            // is what explains the lock, so it has to stay readable.
            const alpha = hasDir ? LOCKED_OPACITY : 255;
            this._zipTitle.opacity = alpha;
            this._zipSwitch.opacity = alpha;
            if (hasDir)
                this._zipSwitch.state = true;
        }

        /* ---------------------------- selection --------------------------- */

        _buildSelection() {
            const actions = new St.BoxLayout({
                style_class: 'tailscale-send-actions',
                x_expand: true,
            });
            const addFiles = new St.Button({
                style_class: 'button tailscale-send-add',
                label: _('Add files'),
                can_focus: true,
                x_expand: true,
            });
            addFiles.connect('clicked', () => this._pick(false));
            actions.add_child(addFiles);

            const addFolders = new St.Button({
                style_class: 'button tailscale-send-add',
                label: _('Add folders'),
                can_focus: true,
                x_expand: true,
            });
            addFolders.connect('clicked', () => this._pick(true));
            actions.add_child(addFolders);
            this.contentLayout.add_child(actions);

            this._fileScroll = new St.ScrollView({
                style_class: 'tailscale-file-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true,
            });
            this._fileList = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'tailscale-send-list',
            });
            this._fileScroll.set_child(this._fileList);
            this.contentLayout.add_child(this._fileScroll);
        }

        // Both chooser trips come through here, and the dialog has to get
        // out of the way twice over. popModal drops the shell grab, without
        // which the portal's window could not take input at all. Hiding is
        // the other half: a ModalDialog lives in the shell's own chrome
        // layer, above every app window, so a merely ungrabbed dialog would
        // still be painted on top of the chooser it just opened.
        async _pick(directory) {
            if (this._picking || this._resolved) return;
            this._picking = true;
            // The tip is parented outside the dialog, so hiding the dialog
            // would otherwise leave it floating over the chooser.
            this._hidePathTip();
            this.popModal();
            this.hide();
            let paths = null;
            try {
                paths = await this._pickFiles(
                    directory ? _('Add folders') : _('Add files'), directory);
            } finally {
                this._picking = false;
                if (!this._resolved) {
                    this.show();
                    // A dialog that lost its grab and cannot get it back is
                    // frozen on screen: close rather than strand the user.
                    if (!this.pushModal())
                        this._finish([]);
                }
            }
            if (paths && paths.length > 0)
                this._addPaths(paths, directory);
        }

        // Rows appear immediately with their size still unknown: measuring a
        // folder means walking it, and the user should see that their click
        // landed before that finishes. `isDir` starts from which chooser the
        // paths came out of, so the row icon is right from the first frame
        // rather than flipping from file to folder once the walk lands.
        _addPaths(paths, isDir = false) {
            const fresh = [];
            for (const path of paths) {
                if (this._entries.has(path)) continue;
                const entry = {
                    path,
                    name: path.split('/').pop(),
                    isDir,
                    size: 0,
                    fileCount: 0,
                    measured: false,
                };
                this._entries.set(path, entry);
                fresh.push(entry);
            }
            if (fresh.length === 0) return;
            this._renderSelection();

            for (const entry of fresh) {
                _measurePath(entry.path).then((m) => {
                    // The row may have been removed, or the whole dialog
                    // closed, while the walk was running.
                    if (this._resolved || this._entries.get(entry.path) !== entry)
                        return;
                    Object.assign(entry, m, { measured: true });
                    this._renderSelection();
                });
            }
        }

        _removePath(path) {
            if (!this._entries.delete(path)) return;
            this._renderSelection();
        }

        _renderSelection() {
            this._fileList.destroy_all_children();

            const entries = [...this._entries.values()];
            this._fileScroll.visible = entries.length > 0;
            for (let i = 0; i < entries.length; i++) {
                if (i > 0) {
                    this._fileList.add_child(new St.Widget({
                        style_class: 'tailscale-send-separator',
                        height: 1,
                        x_expand: true,
                    }));
                }
                this._fileList.add_child(this._makeFileRow(entries[i]));
            }

            const measured = entries.filter((e) => e.measured);
            const total = measured.reduce((sum, e) => sum + e.size, 0);
            const pending = entries.length - measured.length;
            const n = entries.length;
            if (n === 0) {
                this._sendToLabel.text = _('Send to:');
            } else if (pending > 0) {
                // Honest about being provisional: a half-walked selection
                // must not look like a settled total.
                this._sendToLabel.text = _fmt(
                    ngettext('Send %d item (measuring…) to:',
                        'Send %d items (measuring…) to:', n),
                    n);
            } else {
                this._sendToLabel.text = _fmt(
                    ngettext('Send %d item (%s) to:',
                        'Send %d items (%s) to:', n),
                    n, GLib.format_size(total));
            }

            this._syncZip();
            this._syncSendButton();
        }

        _makeFileRow(entry) {
            const row = new St.BoxLayout({
                style_class: 'tailscale-file-row',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                reactive: true,
                track_hover: true,
            });
            // The name is clipped to keep the dialog a sane width, so the
            // path has to be reachable some other way: hovering the row
            // spells it out in full.
            row.connect('notify::hover', () => {
                if (row.hover) this._showPathTip(row, entry.path);
                else this._hidePathTip();
            });
            // A re-render destroys the rows, including one the pointer is
            // still over — which would never emit the leave that hides the
            // tip.
            row.connect('destroy', () => {
                if (row.hover) this._hidePathTip();
            });

            row.add_child(new St.Icon({
                style_class: 'tailscale-file-icon',
                icon_name: entry.isDir
                    ? 'folder-symbolic' : 'text-x-generic-symbolic',
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            // Fixed width, and the size label takes the slack instead: that
            // keeps the sizes on one right-hand edge whatever the names do.
            row.add_child(new St.Label({
                text: entry.name,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'tailscale-file-name',
            }));

            let size;
            if (!entry.measured)
                size = '…';
            else if (entry.isDir && entry.fileCount === 0)
                size = _('empty');
            else
                size = GLib.format_size(entry.size);
            row.add_child(new St.Label({
                text: size,
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'tailscale-file-size',
            }));

            const remove = new St.Button({
                style_class: 'tailscale-file-remove',
                can_focus: true,
                child: new St.Icon({
                    icon_name: 'window-close-symbolic',
                    icon_size: 14,
                }),
            });
            remove.connect('clicked', () => this._removePath(entry.path));
            row.add_child(remove);
            return row;
        }

        /* ------------------------------ peers ----------------------------- */

        _makePeerRow(peer) {
            const btn = new St.Button({
                style_class: 'tailscale-send-row tailscale-send-target',
                can_focus: true,
                x_expand: true,
                track_hover: true,
                toggle_mode: true,
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
                style_class: 'tailscale-peer-ip',
            }));
            row.add_child(text);
            // The dialog only ever lists reachable peers, so the slot that
            // used to carry a status dot — always green, never informative —
            // now carries a selection mark.
            const mark = new St.Label({
                text: '✓',
                style_class: 'tailscale-zip-check',
                y_align: Clutter.ActorAlign.CENTER,
            });
            mark.visible = false;
            row.add_child(mark);
            btn.set_child(row);
            btn.connect('notify::checked', () => {
                mark.visible = btn.checked;
                if (btn.checked) this._selected.add(peer);
                else this._selected.delete(peer);
                this._syncSendButton();
            });
            return btn;
        }

        /* ------------------------------ send ------------------------------ */

        // Sendable means at least one actual file somewhere in the
        // selection: an empty folder would produce an archive with nothing
        // in it, or a plain send with no argument.
        _canSend() {
            if (this._selected.size === 0) return false;
            const entries = [...this._entries.values()];
            if (entries.length === 0) return false;
            if (entries.some((e) => !e.measured)) return false;
            return entries.some((e) => e.fileCount > 0);
        }

        _syncSendButton() {
            if (!this._sendButton) return;
            const ok = this._canSend();
            this._sendButton.reactive = ok;
            this._sendButton.can_focus = ok;
        }

        _send() {
            if (!this._canSend()) return;
            this._finish([...this._selected]);
        }

        _finish(peers) {
            if (this._resolved) return;  // pick-once latch
            this._resolved = true;
            this._hidePathTip();
            this.close();
            this._onPick(peers, {
                files: [...this._entries.keys()],
                asZip: this._asZip,
                password: this._password,
            });
        }
    },
);

/* -------------------------------------------------------------------------- */
/*                             Funnels dialog                                 */
/* -------------------------------------------------------------------------- */

// The whole of Funnel in one place: what is published now, and the form
// that publishes one more. Same visual family as SendFileDialog.
//
// It stays open across both actions, which is the point of merging them.
// Removing a funnel from a dialog that then closed would leave the user
// re-opening it for every entry in a list they came here to prune, and
// adding one without seeing it appear gives no answer to "did that work".
// So the dialog holds no state of its own about the funnels: `render()` is
// called from the outside on every snapshot, and the list, the port
// buttons and the Add button are all rebuilt from it.
//
// Tailscale only allows 443/8443/10000 as public ports (snapshot
// funnelPorts). A port that already carries a funnel is shown greyed:
// re-publishing over it would silently overwrite its serve config, so it
// has to be removed first.
const FunnelsDialog = GObject.registerClass(
    class FunnelsDialog extends ModalDialog.ModalDialog {
        _init({ extension, onAdd, onRemove, onCopy }) {
            super._init({ styleClass: 'tailscale-send-dialog' });
            this._onAdd = onAdd;
            this._onRemove = onRemove;
            this._onCopy = onCopy;
            this._ports = [];
            this._usedPorts = new Set();
            this._selectedPort = null;
            this._portButtons = new Map();

            this.contentLayout.add_child(
                _dialogTitle(extension, _('Funnels')));

            /* ------------------------- published ------------------------- */
            // The list comes first: it is the answer to "what am I exposing
            // to the internet right now", which is the question worth
            // putting at the top of a dialog about Funnel.
            this.contentLayout.add_child(new St.Label({
                style_class: 'tailscale-send-subtitle',
                text: _('Published'),
            }));

            this._scroll = new St.ScrollView({
                style_class: 'tailscale-file-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true,
            });
            this._list = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'tailscale-send-list',
            });
            this._scroll.set_child(this._list);
            this.contentLayout.add_child(this._scroll);

            this.contentLayout.add_child(new St.Widget({
                style_class: 'tailscale-send-separator',
                height: 1,
                x_expand: true,
            }));

            /* ---------------------------- add ---------------------------- */
            this.contentLayout.add_child(new St.Label({
                style_class: 'tailscale-send-subtitle',
                text: _('Publish a local port'),
            }));

            this._entry = new St.Entry({
                style_class: 'tailscale-port-entry',
                text: '3000',
                can_focus: true,
                x_expand: true,
            });
            this._entry.clutter_text.connectObject(
                'activate', () => this._commit(), this);
            this.contentLayout.add_child(this._entry);

            this.contentLayout.add_child(new St.Label({
                style_class: 'tailscale-send-subtitle',
                text: _('Public port'),
            }));
            this._portRow = new St.BoxLayout({
                style_class: 'tailscale-port-choices',
                x_expand: true,
            });
            this.contentLayout.add_child(this._portRow);

            // Only shown once every allowed port is taken, where it stands
            // in for the Add button it explains the death of.
            this._fullLabel = new St.Label({
                style_class: 'tailscale-peer-ip tailscale-send-hint',
                text: _('Every public port is in use. Remove one to publish another.'),
            });
            this._fullLabel.visible = false;
            this.contentLayout.add_child(this._fullLabel);

            this.setButtons([
                {
                    label: _('Close'),
                    action: () => this.close(),
                    key: Clutter.KEY_Escape,
                },
            ]);
            // Kept, like SendFileDialog's Send: render() greys it out once
            // every public port is taken, and Dialog checks
            // `button.reactive` before firing — on the click and on the
            // Return binding that `default: true` installs.
            this._addButton = this.addButton({
                label: _('Add'),
                action: () => this._commit(),
                default: true,
            });
            this.setInitialKeyFocus(this._entry.clutter_text);
        }

        /**
         * Rebuild from a snapshot. Safe to call on every state change: the
         * port entry's text is the only thing the user owns here and it is
         * never touched.
         *
         * @param {{funnels: object[], funnelPorts: number[]}} snap
         */
        render(snap) {
            const funnels = snap.funnels ?? [];
            this._ports = snap.funnelPorts ?? [];
            this._usedPorts = new Set(funnels.map((f) => f.httpsPort));

            this._list.destroy_all_children();
            if (funnels.length === 0) {
                this._list.add_child(new St.Label({
                    style_class: 'tailscale-peer-ip tailscale-send-hint',
                    text: _('Nothing is published yet.'),
                }));
            } else {
                for (const f of funnels)
                    this._list.add_child(this._makeRow(f));
            }

            this._portButtons.clear();
            this._portRow.destroy_all_children();
            for (const port of this._ports) {
                const used = this._usedPorts.has(port);
                const btn = new St.Button({
                    style_class: 'button tailscale-port-choice',
                    label: String(port),
                    can_focus: !used,
                    reactive: !used,
                });
                if (used)
                    btn.add_style_class_name('tailscale-port-choice-used');
                else
                    btn.connect('clicked', () => this._selectPort(port));
                this._portRow.add_child(btn);
                this._portButtons.set(port, btn);
            }

            // Keep the user's choice across a re-render when it is still
            // free; otherwise fall to the first port that is.
            const stillFree = this._selectedPort !== null &&
                this._ports.includes(this._selectedPort) &&
                !this._usedPorts.has(this._selectedPort);
            const firstFree = this._ports.find((p) => !this._usedPorts.has(p));
            this._selectPort(stillFree ? this._selectedPort : firstFree ?? null);

            const full = firstFree === undefined;
            this._fullLabel.visible = full;
            this._entry.reactive = !full;
            this._entry.can_focus = !full;
            this._entry.opacity = full ? LOCKED_OPACITY : 255;
            this._addButton.reactive = !full;
            this._addButton.can_focus = !full;
            this._addButton.opacity = full ? LOCKED_OPACITY : 255;
        }

        _makeRow(f) {
            const url = _funnelUrl(f);
            const row = new St.BoxLayout({
                style_class: 'tailscale-file-row',
                x_expand: true,
            });
            const text = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            text.add_child(new St.Label({
                style_class: 'tailscale-funnel-url',
                text: url,
            }));
            // Only when there is something to say. The public port is
            // already the tail of the URL above, so restating it would fill
            // the second line with the first line's information.
            if (f.target) {
                text.add_child(new St.Label({
                    style_class: 'tailscale-peer-ip',
                    text: _fmt(_('proxies %s'), f.target),
                }));
            }
            row.add_child(text);

            const copyBtn = new St.Button({
                style_class: 'button tailscale-icon-btn',
                accessible_name: _('Copy address'),
                child: new St.Icon({ icon_name: ICON_COPY, icon_size: 16 }),
                y_align: Clutter.ActorAlign.CENTER,
            });
            copyBtn.connect('clicked', () => this._onCopy?.(url));
            row.add_child(copyBtn);

            const removeBtn = new St.Button({
                style_class: 'button tailscale-icon-btn',
                accessible_name: _('Remove funnel'),
                child: new St.Icon({ icon_name: ICON_TRASH, icon_size: 16 }),
                y_align: Clutter.ActorAlign.CENTER,
            });
            removeBtn.connect('clicked', () => this._onRemove?.(f));
            row.add_child(removeBtn);
            return row;
        }

        _selectPort(port) {
            this._selectedPort = port;
            for (const [p, btn] of this._portButtons) {
                if (p === port)
                    btn.add_style_class_name('tailscale-port-choice-selected');
                else
                    btn.remove_style_class_name('tailscale-port-choice-selected');
            }
        }

        // The dialog stays up, so nothing here latches: Add can be pressed
        // again as soon as the list has caught up with the last one.
        _commit() {
            if (this._selectedPort === null) return;
            this._onAdd?.({
                localText: this._entry.get_text(),
                httpsPort: this._selectedPort,
            });
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
            this._banner = new BannerRow();
            this._banner.visible = false;
            this.menu.addMenuItem(this._banner);

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
            this._peersPill = _decorateWithPill(this._peersSubMenu);
            this.menu.addMenuItem(this._peersSubMenu);

            this._exitNodeSubMenu = new PopupMenu.PopupSubMenuMenuItem(
                _('Exit node'),
                true,
            );
            // No warning glyph here: the pill already spells the state out
            // in words ("Auto (None)", "Offline (…)"), and the panel
            // indicator carries the same signal for anyone not looking at
            // the menu. Two glyphs for one fact was one too many.
            this._exitNodePill = _decorateWithPill(this._exitNodeSubMenu);
            this.menu.addMenuItem(this._exitNodeSubMenu);

            this._sep2 = new PopupMenu.PopupSeparatorMenuItem();
            this.menu.addMenuItem(this._sep2);

            // DNS first (more commonly toggled than routes).
            this._acceptDNSRow = new ToggleRow(_('Magic DNS'), (v) =>
                this._withFeedback(
                    Category.NETWORK,
                    v ? _('Enabling Magic DNS') : _('Disabling Magic DNS'),
                    v ? _('Magic DNS: on') : _('Magic DNS: off'),
                    () => this._client.setAcceptDNS(v),
                ),
            );
            this.menu.addMenuItem(this._acceptDNSRow);

            // Combined toggle + read-only submenu for routes.
            this._routesToggle = new RoutesSubToggle((v) =>
                this._withFeedback(
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
                this._withFeedback(
                    Category.NETWORK,
                    v ? _('Enabling Shields up') : _('Disabling Shields up'),
                    v ? _('Shields up: on') : _('Shields up: off'),
                    () => this._client.setShieldsUp(v),
                ),
            );
            this.menu.addMenuItem(this._shieldsUpRow);

            this._runSSHRow = new ToggleRow(_('Run SSH server'), (v) =>
                this._withFeedback(
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
            // feature — the picker and the recipients for Taildrop, the
            // published list and the add form for Funnel — so neither has
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
                style_class: 'tailscale-bottom-buttons',
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
                // focus instead of the shell stealing it back. Then
                // explicitly raise an already-open prefs window with the
                // current event timestamp. The raise delay is tracked on
                // the toggle (and re-armed, not stacked) so destroy() can
                // remove it.
                const id = this.menu.connect('open-state-changed', (_m, isOpen) => {
                    if (isOpen) return;
                    this.menu.disconnect(id);
                    this._extension.openPreferences();
                    if (this._raiseTimeoutId)
                        GLib.source_remove(this._raiseTimeoutId);
                    this._raiseTimeoutId = GLib.timeout_add(
                        GLib.PRIORITY_DEFAULT, 120, () => {
                            this._raiseTimeoutId = 0;
                            _activatePrefsWindow(this._extension);
                            return GLib.SOURCE_REMOVE;
                        });
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
                this._withFeedback(
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
                snap.backendState !== 'NeedsLogin' &&
                snap.backendState !== 'NoState';
            if (!ready) {
                this.checked = !!snap.running;
                if (snap.loggedOut || snap.backendState === 'NeedsLogin') {
                    // Logged out beats operator-missing: login restores
                    // the operator pref itself, so steer there instead of
                    // firing a redundant pkexec prompt.
                    Notifier.notify({
                        category: Category.CONNECTION,
                        level: 'info',
                        message: _('Login required (see Account menu)'),
                    });
                    this.menu.open();
                } else if (!snap.canControl) {
                    // Operator missing → fire pkexec prompt directly so the
                    // user doesn't have to dig into the menu to find the
                    // "Set operator" button.
                    this._client.setOperator();
                } else {
                    // NoState: daemon still starting or unreachable.
                    Notifier.notify({
                        category: Category.CONNECTION,
                        level: 'info',
                        message: this._statusText(snap),
                    });
                }
                return;
            }
            if (this.checked) {
                this._withFeedback(
                    Category.CONNECTION,
                    _('Connecting Tailscale'),
                    _('Tailscale connected'),
                    () => this._client.up(),
                );
            } else {
                this._withFeedback(
                    Category.CONNECTION,
                    _('Disconnecting Tailscale'),
                    _('Tailscale disconnected'),
                    () => this._client.down(),
                );
            }
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

            const needsLogin = snap.loggedOut ||
                snap.backendState === 'NeedsLogin';

            // Operator gate: when control is denied while logged IN, show
            // only the operator row and the Extension Settings button.
            // While logged OUT the gate is skipped even without operator:
            // `login` restores the pref by itself (--operator flag), so
            // the Login entry must stay reachable — that is what keeps
            // logout at a single polkit prompt.
            if (!snap.canControl && !needsLogin) {
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
            // Hide all network settings — they require an authenticated session.
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
                copyTargets: _copyTargetsFor({
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
            // Reachable with the menu button hidden: the keyboard shortcut
            // fires wherever the user is. Saying so beats a dialog whose
            // every action would come back refused by the control plane —
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
        // the funnel's identity — it is the port in the URL.
        _removeFunnel(f) {
            return this._withFeedback(
                Category.FUNNEL,
                _fmt(_('Removing funnel %s'), _funnelPorts(f)),
                _fmt(_('Funnel removed %s'), _funnelPorts(f)),
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

            // addFunnel may return notEnabled (browser approval needed) — in
            // that case _withFeedback's "success" branch ends up wrong, so we
            // peek the result and override the report with an info message.
            let openedApproval = null;
            const r = await this._withFeedback(
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
            // accepted via --accept-routes — they ride on the exit-node
            // selection — so listing them inline with real subnets is
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

            // Pill counts only meaningful subnet routes — the catch-alls are
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

        _statusText(snap) {
            return statusText(snap);
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
                    onClick: () => this._withFeedback(
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
                    onClick: () => this._withFeedback(
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
                            onClick: () => this._withFeedback(
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
                    this._withFeedback(
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
                        copyTargets: _copyTargetsFor({
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
            // account can reach several tailnets — being a guest in someone
            // else's tailnet is the ordinary case — so the tailnet is the
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
            // state — the client elevates the switch itself — so this is a
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
                                this._withFeedback(
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
                this._withFeedback(
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
                    this._withFeedback(
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
        // next poll like every other fact about the tailnet. `null` — a
        // daemon that publishes no capability map — is not a refusal, and
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
        // the whole action — calling client.setAcceptFiles() as well would
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
        // opens the portal chooser itself — once per kind, because no single
        // chooser yields files and folders together. Paths may also arrive
        // pre-selected from the Nautilus D-Bus call, in which case they are
        // simply what the dialog starts with. Peers come from
        // `tailscale file cp --targets`, which only lists nodes that can
        // actually receive Taildrop files.
        async runSendFlow(preselectedFiles) {
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
        // archive — possibly an encrypted one — sitting in /tmp.
        async _sendTo(peers, files, { asZip, password }) {
            const label = files.length === 1
                ? files[0].split('/').pop()
                : _fmt(_('%d files'), files.length);
            const where = peers.length === 1
                ? peers[0].host
                : _fmt(_('%d devices'), peers.length);

            // One transfer per recipient — `tailscale file cp` takes a single
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
            // that is what gets named — "Sent 3 files" would describe
            // something the recipient never receives, and would not match
            // the name they have to look for. Settled up front, before the
            // archive exists, so the message can be written now.
            const archiveName = asZip ? _archiveName() : null;
            const sentMsg = _fmt(_('Sent %s to %s'), archiveName ?? label, where);

            if (!asZip) {
                await this._withFeedback(
                    Category.TAILDROP,
                    _fmt(_('Sending %s to %s'), label, where),
                    sentMsg,
                    () => fanOut(files),
                );
                return;
            }

            await this._withFeedback(
                Category.TAILDROP,
                _fmt(_('Archiving %s'), label),
                sentMsg,
                async () => {
                    // Built once and reused: the archive is byte-identical
                    // for every recipient, and zipping per target would pay
                    // the cost — and the encryption — N times over.
                    const archive =
                        await _makeArchive(files, password, archiveName);
                    if (!archive) {
                        return {
                            ok: false,
                            message: _('Could not create the archive'),
                        };
                    }
                    try {
                        return await fanOut([archive.path]);
                    } finally {
                        _removeTree(Gio.File.new_for_path(archive.dir));
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
        // (org.freedesktop.portal.FileChooser) — plain D-Bus on the session
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
                        // never both — the portal has no mixed mode and GTK4
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

        // Feedback notifications live in Notifier (shared with extension.js);
        // the alias just keeps the many call sites above short.
        _withFeedback(category, pending, success, fn) {
            return Notifier.withFeedback(category, pending, success, fn);
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
