// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// Where inbound Taildrop files land when the user has not picked a folder.
//
// The choice is the user's download directory, which is a per-machine
// answer: these tests never assert a concrete path off the machine they
// run on. What they pin down is the order of the fallbacks and what each
// step is allowed to accept, which is the part that does not vary.

import { suite, test, assertEq, assertTrue } from './harness.js';
import { chooseDownloadDir, taildropInboxDefault } from '../lib/util.js';

const HOME = '/home/tester';

// The filesystem probe the third fallback makes, as a fixture: the set of
// directories the fake machine has. Defaults to none, so a test that says
// nothing about the filesystem is testing a machine without ~/Downloads.
function choose({ specialDir = null, envDir = null, existing = [] } = {}) {
    return chooseDownloadDir({
        specialDir,
        envDir,
        homeDir:   HOME,
        dirExists: (p) => existing.includes(p),
    });
}

suite('chooseDownloadDir', () => {
    test('the desktop\'s own download directory outranks everything', () => {
        assertEq(
            choose({
                specialDir: '/home/tester/dl',
                envDir:     '/home/tester/elsewhere',
                existing:   [`${HOME}/Downloads`],
            }),
            '/home/tester/dl',
        );
    });

    test('the environment variable is the fallback, not the source', () => {
        assertEq(
            choose({ envDir: '/home/tester/dl', existing: [`${HOME}/Downloads`] }),
            '/home/tester/dl',
        );
    });

    test('an unexpanded $HOME is expanded, both forms', () => {
        assertEq(choose({ envDir: '$HOME/dl' }), '/home/tester/dl');
        assertEq(choose({ envDir: '~/dl' }), '/home/tester/dl');
        assertEq(choose({ envDir: '$HOME' }), HOME);
        assertEq(choose({ envDir: '~' }), HOME);
    });

    test('a trailing slash does not survive into the path', () => {
        assertEq(choose({ specialDir: '/home/tester/dl/' }), '/home/tester/dl');
        assertEq(choose({ specialDir: '/home/tester/dl///' }), '/home/tester/dl');
    });

    test('a value that is not absolute is dropped, not guessed at', () => {
        // Falls through to home: ~/Downloads is absent on this fake machine.
        assertEq(choose({ specialDir: 'dl', envDir: 'Downloads' }), HOME);
        assertEq(choose({ specialDir: '', envDir: '   ' }), HOME);
        assertEq(choose({ specialDir: null, envDir: null }), HOME);
    });

    test('~/Downloads is used only when it really exists', () => {
        assertEq(
            choose({ existing: [`${HOME}/Downloads`] }),
            `${HOME}/Downloads`,
        );
        assertEq(choose({ existing: [] }), HOME);
    });

    test('home is the last resort, never an invented directory', () => {
        assertEq(choose(), HOME);
    });
});

suite('taildropInboxDefault', () => {
    // Runs against the real machine, so the only claims made are the ones
    // that hold on any of them.
    test('is absolute and sits in its own subfolder', () => {
        const inbox = taildropInboxDefault();
        assertTrue(inbox.startsWith('/'), 'inbox should be absolute');
        assertTrue(inbox.endsWith('/Taildrop'), 'inbox should end in /Taildrop');
    });

    test('does not put the subfolder at the filesystem root', () => {
        assertTrue(
            taildropInboxDefault() !== '/Taildrop',
            'home or download dir should precede the subfolder',
        );
    });
});
