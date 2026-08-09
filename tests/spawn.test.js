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
    privilegedArgv,
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

// The elevated vector. Two things matter and neither depends on the
// machine: the command still says what it looks like it says, and
// whatever is prepended to make NixOS work is prepended *before* the CLI
// rather than folded into its arguments.
//
// Written so it holds on a machine with /usr/bin/env and on one without,
// because privilegedArgv() degrades to the plain form there and the test
// suite is not allowed to assume a system path exists.
suite('privilegedArgv', () => {
    const BIN = '/usr/bin/tailscale';
    const ARGS = ['set', '--operator=someone'];

    test('elevates with pkexec and nothing else in front', () => {
        assertEq(privilegedArgv(BIN, ARGS)[0], 'pkexec');
    });

    // The tail is the contract: the CLI, then its arguments, in order and
    // untouched. A prefix may grow ahead of it; nothing may be inserted
    // into it, dropped from it or reordered.
    test('ends with the CLI followed by its arguments, in order', () => {
        const argv = privilegedArgv(BIN, ARGS);
        assertEq(argv.slice(-1 - ARGS.length).join(' '),
            [BIN, ...ARGS].join(' '));
    });

    // No shell, ever: the EGO review reads this vector as-is.
    test('never routes through a shell', () => {
        const argv = privilegedArgv(BIN, ARGS);
        assertTrue(!argv.includes('-c'), 'no -c');
        assertTrue(!argv.some((a) => a.endsWith('sh')), 'no shell program');
    });

    // And when the env indirection is there, it is there whole: the
    // variable set before the CLI, never after it, where it would land in
    // Tailscale's own argument list instead of its environment.
    test('places TS_BE_CLI ahead of the CLI when it is used', () => {
        const argv = privilegedArgv(BIN, ARGS);
        const varIdx = argv.indexOf('TS_BE_CLI=1');
        if (varIdx === -1) {
            // No /usr/bin/env on this machine: plain form, nothing to check
            // beyond the tail contract above.
            assertEq(argv.length, 2 + ARGS.length);
            return;
        }
        assertEq(argv[1], '/usr/bin/env');
        assertTrue(varIdx < argv.indexOf(BIN), 'set before the CLI');
    });
});
