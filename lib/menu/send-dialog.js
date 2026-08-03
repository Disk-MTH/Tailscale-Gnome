// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// The Taildrop send flow: the modal that owns the selection, and the
// archiving it needs when a folder is in it. Split out of menu.js because
// none of it is menu: the toggle opens the dialog and takes the answer.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    gettext as _, ngettext,
} from 'resource:///org/gnome/shell/extensions/extension.js';

import { fmt as _fmt } from '../util.js';
import { LOCKED_OPACITY, dialogTitle } from './rows.js';

/**
 * Whether a password can safely be handed to `zip`.
 *
 * The passphrase travels in ZIPOPT rather than argv, because /proc's
 * cmdline is world-readable while environ is not: a password on the
 * command line would be visible to every local user for as long as the
 * archive takes to build. zip parses ZIPOPT by splitting on whitespace,
 * so a password containing any is the one thing that cannot be carried
 * this way, and silently falling back to argv would trade the user's
 * secret for their convenience without telling them.
 *
 * @param {string} password
 * @returns {boolean}
 */
function _isUsablePassword(password) {
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
 * together: an empty folder must not enable Send, and its size line must
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
 * @param {string} name basename to give the archive, from `archiveName`
 * @returns {Promise<{dir: string, path: string}|null>}
 */
export async function makeArchive(paths, password, name) {
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
            removeTree(Gio.File.new_for_path(dir));
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
export function archiveName() {
    const stamp = GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S');
    return `taildrop-${stamp}.zip`;
}

// Depth-first delete. The temp directory holds exactly one archive we
// created, so this never walks anything the user owns.
export function removeTree(file) {
    try {
        const en = file.enumerate_children(
            'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null)) !== null) {
            const child = file.get_child(info.get_name());
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                removeTree(child);
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
export const SendFileDialog = GObject.registerClass(
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
                dialogTitle(extension, _('Send via Taildrop')));

            this._buildZipControls();
            this._buildSelection();

            // One line instead of two: the tally and the "send to" lead-in
            // read as a single sentence, "Send 4 items (9.8 MB) to", so
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
            // a label of our own. It lives outside the dialog's layout:
            // inside it, appearing would resize the dialog under the pointer.
            this._pathTip = new St.Label({
                style_class: 'tailscale-path-tip',
                visible: false,
            });
            Main.layoutManager.uiGroup.add_child(this._pathTip);

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
        // files, so a directory can only travel as an archive: the switch
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
            this._zipSwitch.connectObject('notify::state', () => {
                this._asZip = this._zipSwitch.state;
                this._pwBox.visible = this._asZip;
            }, this);
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

            pwEntry.clutter_text.connectObject('text-changed', () => {
                const text = pwEntry.get_text();
                // An unusable password is treated as none rather than
                // quietly encrypting with a mangled one.
                this._password = _isUsablePassword(text) ? text : '';
                pwHint.visible = text.length > 0 && !_isUsablePassword(text);
            }, this);

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
            // switch is not an St.Label and CSS opacity did not reach it;
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
            // still over, which would never emit the leave that hides the
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
            // used to carry a status dot (always green, never informative)
            // now carries a selection mark.
            const mark = new St.Icon({
                icon_name: 'object-select-symbolic',
                icon_size: 16,
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

        // Every widget this dialog owns, torn down by hand before the tree
        // that holds them. super.destroy() would reach all but _pathTip on
        // its own; naming them is what lets a reviewer (and the EGO
        // tooling) see the ownership rather than infer it. Leaves go
        // before their containers, so nothing is destroyed twice.
        destroy() {
            this._zipTitle?.destroy();
            this._zipTitle = null;
            this._zipForcedLabel?.destroy();
            this._zipForcedLabel = null;
            this._zipSwitch?.destroy();
            this._zipSwitch = null;
            this._zipButton?.destroy();
            this._zipButton = null;
            this._pwBox?.destroy();
            this._pwBox = null;

            this._fileList?.destroy();
            this._fileList = null;
            this._fileScroll?.destroy();
            this._fileScroll = null;

            this._sendToLabel?.destroy();
            this._sendToLabel = null;
            this._sendButton?.destroy();
            this._sendButton = null;

            // Parented to uiGroup rather than to the dialog, so this is the
            // one actor here that would otherwise outlive it.
            this._pathTip?.destroy();
            this._pathTip = null;

            this._entries.clear();
            this._selected.clear();

            super.destroy();
        }
    },
);
