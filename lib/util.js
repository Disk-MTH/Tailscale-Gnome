// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// Helpers shared between the GNOME Shell process (extension.js, lib/) and
// the preferences process (prefs.js). Only process-neutral imports are
// allowed here: no St/Clutter/Meta/Shell, no Gtk/Adw.
//
// Nothing here starts a process. Everything that does lives in spawn.js,
// which is the extension's only launch site.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Node capabilities the daemon publishes in `status --json` Self.CapMap.
// The shell process reads them on every availability probe; the prefs
// process reads the same keys behind the per-feature Check buttons, so
// both always agree on what the tailnet allows.
export const CAP_FILE_SHARING = 'https://tailscale.com/cap/file-sharing';
export const CAP_FUNNEL = 'funnel';

/**
 * Minimal printf-style substitution for translated strings: replaces each
 * %s / %d in order with the corresponding argument.
 *
 * @param {string} template
 * @param {...*} args
 * @returns {string}
 */
export function fmt(template, ...args) {
    let i = 0;
    return template.replace(/%[sd]/g, () => {
        const v = args[i++];
        return v === undefined || v === null ? '' : String(v);
    });
}

// The subfolder inbound Taildrop files land in, under whichever download
// directory was chosen below. Kept as a folder of its own rather than the
// download directory itself: transfers arriving unannounced from other
// machines have no business mixing into what the browser puts there.
const TAILDROP_SUBDIR = 'Taildrop';

// Normalise one candidate directory, or reject it.
//
// Both forms show up in the wild. user-dirs.dirs stores its paths as
// "$HOME/yyy" and GLib expands them on the way out, but an XDG_DOWNLOAD_DIR
// exported by hand from a shell profile can reach us with the $HOME still
// literal. Anything that is not absolute once that is done is not a
// directory this extension can act on, so it is dropped rather than
// guessed at: the next fallback is a better answer than a path built out
// of a value nobody can resolve.
function _asDirectory(path, homeDir) {
    let p = (path ?? '').trim();
    if (!p) return null;

    if (p === '~' || p === '$HOME') p = homeDir;
    else if (p.startsWith('~/')) p = GLib.build_filenamev([homeDir, p.slice(2)]);
    else if (p.startsWith('$HOME/'))
        p = GLib.build_filenamev([homeDir, p.slice(6)]);

    if (!p.startsWith('/')) return null;
    // "/" itself keeps its slash; everything else loses the trailing one so
    // two spellings of the same directory cannot read as two directories.
    return p.replace(/\/+$/, '') || '/';
}

/**
 * Which directory the user downloads into, as a fallback chain.
 *
 * Pure on purpose: every system answer is passed in, so the order of the
 * fallbacks can be tested without a machine that has the layout under
 * test. taildropInboxDefault() below is the half that reads the system.
 *
 * @param {object} sources
 * @param {?string} sources.specialDir  GLib's XDG download directory
 * @param {?string} sources.envDir      $XDG_DOWNLOAD_DIR
 * @param {string} sources.homeDir      the user's home
 * @param {function(string): boolean} sources.dirExists
 * @returns {string} an absolute directory
 */
export function chooseDownloadDir({ specialDir, envDir, homeDir, dirExists }) {
    // 1. What the desktop itself uses. GLib reads ~/.config/user-dirs.dirs,
    //    which is the same file Files, the browsers and the portals read,
    //    so following it is what makes the inbox land where the user
    //    already expects downloads to land.
    const special = _asDirectory(specialDir, homeDir);
    if (special) return special;

    // 2. The variable xdg-user-dirs exports out of that same file. Only
    //    reached on a machine that has no user-dirs.dirs to read but does
    //    export the variable from a profile, which is the one case where
    //    the environment knows something GLib does not.
    const env = _asDirectory(envDir, homeDir);
    if (env) return env;

    // 3. The conventional name, and only when it is really there. Creating
    //    ~/Downloads on a machine that deliberately has no such folder
    //    would be this extension deciding where the whole session
    //    downloads to, which is not its call to make.
    const conventional = GLib.build_filenamev([homeDir, 'Downloads']);
    if (dirExists(conventional)) return conventional;

    // 4. Home. Always there, always writable, and the subfolder appended
    //    by the caller keeps the files from landing loose in it.
    return homeDir;
}

/**
 * Default Taildrop inbox: the user's download directory, plus a subfolder
 * of our own. The single source of truth for that default, read by the
 * receiver in the shell process and by the preferences window alike.
 *
 * @returns {string} absolute path, not created here
 */
export function taildropInboxDefault() {
    return GLib.build_filenamev([
        chooseDownloadDir({
            specialDir: GLib.get_user_special_dir(
                GLib.UserDirectory.DIRECTORY_DOWNLOAD),
            envDir:    GLib.getenv('XDG_DOWNLOAD_DIR'),
            homeDir:   GLib.get_home_dir(),
            dirExists: (p) => Gio.File.new_for_path(p).query_exists(null),
        }),
        TAILDROP_SUBDIR,
    ]);
}

/**
 * Reveal a file in the desktop's file manager, with the file itself
 * selected inside its folder.
 *
 * org.freedesktop.FileManager1 is the cross-desktop interface for exactly
 * this (Nautilus, Dolphin, Thunar and Nemo all implement it), and it is
 * what makes the file land selected rather than the folder merely opening.
 * When no file manager owns the name (a bare session, or one whose file
 * manager predates the spec) the parent directory is opened through the
 * regular URI handler instead, which is the closest thing still available.
 *
 * @param {string} path absolute path of the file to reveal
 */
export function showInFileManager(path) {
    if (!path) return;
    const file = Gio.File.new_for_path(path);
    const openParent = () => {
        const parent = file.get_parent();
        if (parent)
            Gio.AppInfo.launch_default_for_uri(parent.get_uri(), null);
    };
    Gio.DBus.session.call(
        'org.freedesktop.FileManager1',
        '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1',
        'ShowItems',
        new GLib.Variant('(ass)', [[file.get_uri()], '']),
        null,
        Gio.DBusCallFlags.NONE,
        -1,
        null,
        (bus, res) => {
            try {
                bus.call_finish(res);
            } catch {
                openParent();
            }
        },
    );
}

/**
 * Directory holding the bundled symbolic icons, relative to the extension
 * root. The hicolor/<size>/<context> layout is what lets the preferences
 * process register the same files with Gtk.IconTheme.add_search_path() and
 * then address them by plain name, which is the only thing Adw page
 * `iconName` properties accept. The Shell process cannot use that path
 * (adding to the shared icon theme would leak into the whole session), so
 * it resolves the very same files through gicon() below.
 *
 * @param {import('resource:///org/gnome/shell/extensions/extension.js').Extension} extension
 * @returns {Gio.File}
 */
function _iconDir(extension) {
    return extension.dir.get_child('icons');
}

/**
 * Gio.Icon for one of the extension's bundled SVG icons.
 *
 * @param {import('resource:///org/gnome/shell/extensions/extension.js').Extension} extension
 * @param {string} name  basename without extension, e.g. "tailscale-symbolic"
 * @returns {Gio.FileIcon}
 */
export function gicon(extension, name) {
    return new Gio.FileIcon({
        file: _iconDir(extension)
            .get_child('hicolor')
            .get_child('scalable')
            .get_child('actions')
            .get_child(`${name}.svg`),
    });
}
