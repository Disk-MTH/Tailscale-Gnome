// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// Which windows the Taildrop shortcut is willing to read a selection from.
//
// The rest of that module is a D-Bus call and a look at the focused window,
// neither of which exists outside a running shell. This part does, and it
// is the part with a decision in it: say yes to the wrong window class and
// the shortcut sends whatever some other program happened to leave in the
// cache. So it is pinned here, where a rename or a stray substring match
// fails a test instead of shipping.

import { suite, test, assertTrue } from './harness.js';
import { isFileManagerWindow } from '../lib/nautilus-selection.js';

suite('isFileManagerWindow', () => {
    // Wayland reports the application id, X11 the WM_CLASS, and the
    // spelling lost its capital around GNOME 40. All three are Nautilus.
    test('accepts the file manager however it spells itself', () => {
        for (const cls of ['org.gnome.Nautilus', 'org.gnome.nautilus',
            'Nautilus', 'nautilus']) {
            assertTrue(isFileManagerWindow(cls), cls);
        }
    });

    test('rejects anything else', () => {
        for (const cls of ['firefox', 'org.gnome.Console', 'code']) {
            assertTrue(!isFileManagerWindow(cls), cls);
        }
    });

    // A window with no class at all is the state an unmapped or just-mapped
    // window reports, and get_wm_class() answers null for it. Reading that
    // as "not the file manager" is what keeps the shortcut from acting on a
    // window nobody is looking at yet.
    test('rejects a missing class rather than throwing', () => {
        assertTrue(!isFileManagerWindow(null));
        assertTrue(!isFileManagerWindow(undefined));
        assertTrue(!isFileManagerWindow(''));
    });

    // Substring matching would be the tempting shortcut and the wrong one:
    // a window class is an identity, not a hint, and "not-nautilus" is not
    // Nautilus.
    test('matches the whole class, never a fragment', () => {
        for (const cls of ['not-nautilus', 'nautilus-admin',
            'org.gnome.Nautilus.Devel', 'my.nautilus']) {
            assertTrue(!isFileManagerWindow(cls), cls);
        }
    });
});
