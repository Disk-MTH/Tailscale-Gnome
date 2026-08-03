// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// Helpers shared between the GNOME Shell process (extension.js, lib/) and
// the preferences process (prefs.js). Only process-neutral imports are
// allowed here: no St/Clutter/Meta/Shell, no Gtk/Adw.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Node capabilities the daemon publishes in `status --json` Self.CapMap.
// The shell process reads them on every availability probe; the prefs
// process reads the same keys behind the per-feature Check buttons, so
// both always agree on what the tailnet allows.
export const CAP_FILE_SHARING = 'https://tailscale.com/cap/file-sharing';
export const CAP_FUNNEL = 'funnel';

// The one and only program name this extension ever runs. Not
// configurable, and deliberately so: the privileged calls must stay
// literal argument vectors for review, and a setting that only steered
// the unprivileged half would mean half the extension talking to a
// different binary than the other half.
export const TAILSCALE_BIN = 'tailscale';

/**
 * Whether the Tailscale CLI exists on PATH at all, a different question
 * from "the daemon is not answering", and one that deserves a different
 * answer on screen: there is nothing to answer with, so every control that
 * drives a command is dead until a package is installed.
 *
 * Lives here because both processes must agree on it: the shell hides the
 * menu, the preferences say why. It is a PATH walk rather than a spawn,
 * cheap enough for the shell to redo on every poll, which is what lets
 * the extension come back on its own, with no reload, the moment Tailscale
 * is installed.
 *
 * @returns {boolean}
 */
export function hasTailscaleCli() {
    return GLib.find_program_in_path(TAILSCALE_BIN) !== null;
}

/**
 * Run a child process asynchronously and resolve with
 * { ok, code, stdout, stderr }. Never throws on a non-zero exit: callers
 * decide how to react. A cancelled call resolves with `cancelled: true`
 * rather than rejecting, so teardown paths stay quiet.
 *
 * @param {string[]} argv
 * @param {Gio.Cancellable|null} [cancellable]
 * @returns {Promise<{ok: boolean, code: number, stdout: string, stderr: string, cancelled?: boolean}>}
 */
export function spawn(argv, cancellable = null) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            );
        } catch (e) {
            reject(e);
            return;
        }

        proc.communicate_utf8_async(null, cancellable, (p, res) => {
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                resolve({
                    ok: p.get_successful(),
                    code: p.get_exit_status(),
                    stdout: stdout ?? '',
                    stderr: stderr ?? '',
                });
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                    resolve({
                        ok: false, code: -1, stdout: '',
                        stderr: 'cancelled', cancelled: true,
                    });
                } else {
                    reject(e);
                }
            }
        });
    });
}

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
