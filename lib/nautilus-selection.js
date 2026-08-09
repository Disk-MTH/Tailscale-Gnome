// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// What the file manager currently has selected, asked for once, at the
// moment the Taildrop shortcut fires.
//
// The right-click entry has had the selection all along: Nautilus hands it
// to the menu item it built. The shortcut had nothing, so it opened an
// empty picker, and someone working from the keyboard had to find the same
// files a second time. This closes that gap without changing either
// dialog: the shortcut fills the picker it already opens.
//
// Asked for, never pushed. Nautilus knows its selection the whole time it
// is running, and the obvious design is to have it send every change over
// to the shell. That would mean a message per selection while browsing and
// a running record, in the shell, of what the user is looking at, to serve
// a shortcut pressed once in a while. So the paths stay in Nautilus and
// the shell asks for them when it needs them, which is also why this
// module holds no state of its own.
//
// Separate from lib/nautilus.js, which installs the integration and is
// read by the preferences process too. This one reads `global`, so it
// belongs to the shell alone.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Matches nautilus/tailscale-taildrop.py. A name of our own rather than
// something under org.gnome.Shell: the process answering here is the file
// manager, and a name is a claim about who is speaking.
const BUS_NAME = 'fr.diskmth.TailscaleGnome.Nautilus';
const OBJECT_PATH = '/fr/diskmth/TailscaleGnome/Nautilus';
const INTERFACE = 'fr.diskmth.TailscaleGnome.Nautilus';

// Short on purpose. This sits between a keypress and a dialog, so the cost
// of waiting is paid by the user watching nothing happen. Nautilus answers
// from a variable it already holds; anything slower than this means it is
// not going to answer at all.
const CALL_TIMEOUT_MS = 300;

// Wayland reports the application id, X11 the WM_CLASS, and the name lost
// its capital somewhere around GNOME 40. Compared case-insensitively so
// the list stays about which program it is, not how it spells itself.
const FILE_MANAGER_CLASSES = ['org.gnome.nautilus', 'nautilus'];

/**
 * Whether a window class belongs to the file manager we integrate with.
 *
 * Exported for its own sake: it is the one piece of this module that can
 * be checked without a session bus and without a shell to hold a focused
 * window.
 *
 * @param {string|null} wmClass
 * @returns {boolean}
 */
export function isFileManagerWindow(wmClass) {
    if (!wmClass) return false;
    return FILE_MANAGER_CLASSES.includes(wmClass.toLowerCase());
}

/**
 * Paths the file manager has selected, or an empty array.
 *
 * Empty covers every case where the answer would be a guess: another
 * application has the keyboard, the integration is off so nothing owns the
 * name, Nautilus is running an older copy of the script, the selection is
 * on a gvfs mount with no local path, or the call did not come back in
 * time. The caller treats all of them the same way, by opening the picker
 * it would have opened anyway.
 *
 * The focus check is what keeps this predictable rather than clever: the
 * shortcut reaches across the whole session, and a selection made in a
 * file manager the user has since left is not what they are pointing at.
 *
 * Never rejects.
 *
 * @returns {Promise<string[]>}
 */
export function selectedFiles() {
    return new Promise((resolve) => {
        const win = global.display?.focus_window;
        if (!win || !isFileManagerWindow(win.get_wm_class?.())) {
            resolve([]);
            return;
        }

        // NO_AUTO_START: the name is owned by a Nautilus that is already
        // up, and a shortcut must never be what launches a file manager.
        Gio.DBus.session.call(
            BUS_NAME, OBJECT_PATH, INTERFACE, 'GetSelection', null,
            new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NO_AUTO_START,
            CALL_TIMEOUT_MS, null,
            (bus, res) => {
                try {
                    const [paths] = bus.call_finish(res).deepUnpack();
                    resolve(paths ?? []);
                } catch {
                    resolve([]);
                }
            },
        );
    });
}
