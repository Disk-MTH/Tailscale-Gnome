// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// Which binary the extension runs, and which one it is willing to run as
// root. The second question is the one with teeth: everything privileged
// goes through `pkexec <path>`, so a path this module accepts is a path
// the machine's owner gets a root shell from.
//
// These tests run against the real filesystem, so they never assert that
// a given system path exists. What they pin down is the invariant that
// does not depend on the machine: a Tailscale outside the system
// directories is never what comes back for elevation.

import GLib from 'gi://GLib';

import { suite, test, assertEq, assertTrue } from './harness.js';
import {
    TAILSCALE_BIN, hasTailscaleCli, tailscaleBin, privilegedTailscaleBin,
} from '../lib/spawn.js';

// Same shape as tailscale.test.js: PATH is the whole fixture, and it is
// restored on every exit path so a leak cannot take the rest of the file
// down with it.
function withPath(value, fn) {
    const saved = GLib.getenv('PATH');
    GLib.setenv('PATH', value, true);
    try {
        return fn();
    } finally {
        GLib.setenv('PATH', saved ?? '', true);
    }
}

// A directory that is emphatically not a system one, holding an
// executable called `tailscale`: what a user-local install looks like,
// and what someone trying to get a root shell out of this extension
// would arrange.
const root = GLib.dir_make_tmp('tailscale-gnome-spawn-XXXXXX');
const binDir = GLib.build_filenamev([root, 'bin']);
const emptyDir = GLib.build_filenamev([root, 'empty']);
GLib.mkdir_with_parents(binDir, 0o755);
GLib.mkdir_with_parents(emptyDir, 0o755);
const stub = GLib.build_filenamev([binDir, TAILSCALE_BIN]);
GLib.file_set_contents(stub, '#!/bin/sh\nexit 0\n');
GLib.chmod(stub, 0o755);

suite('tailscaleBin', () => {
    test('answers with the CLI PATH resolves to', () => {
        withPath(binDir, () => {
            assertEq(tailscaleBin(), stub);
            assertEq(hasTailscaleCli(), true);
        });
    });

    test('answers null when PATH has none', () => {
        withPath(emptyDir, () => {
            assertEq(tailscaleBin(), null);
            assertEq(hasTailscaleCli(), false);
        });
    });

    test('always an absolute path, never the bare name', () => {
        withPath(binDir, () => {
            assertTrue(tailscaleBin().startsWith('/'));
        });
    });
});

suite('privilegedTailscaleBin', () => {
    // The point of the whole module. PATH belongs to the session, so a
    // hit in it is a hit the session chose; elevating that would turn
    // "can write to a directory on your PATH" into "is root".
    test('never elevates a CLI found outside the system directories', () => {
        withPath(binDir, () => {
            const priv = privilegedTailscaleBin();
            assertTrue(priv !== stub, 'the PATH stub must not be elevated');
            assertTrue(priv !== binDir, 'nor its directory');
        });
    });

    // Whatever it does answer is a system path, on any machine: either
    // null (no system Tailscale) or something not under the temp root.
    test('answers null or a path outside the session\'s reach', () => {
        withPath(binDir, () => {
            const priv = privilegedTailscaleBin();
            assertTrue(priv === null || !priv.startsWith(root));
        });
    });

    // An empty PATH must not change the answer: the fallback list is
    // consulted either way, so a session that lost its PATH still gets
    // its operator prompt rather than a silent failure.
    test('does not depend on PATH being usable', () => {
        const fromStubPath = withPath(binDir, () => privilegedTailscaleBin());
        const fromEmptyPath = withPath(emptyDir, () => privilegedTailscaleBin());
        assertEq(fromStubPath, fromEmptyPath);
    });
});
