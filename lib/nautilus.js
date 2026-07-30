// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// Nautilus integration: symlink nautilus/tailscale-taildrop.py into the file
// manager's own extensions directory, and take it back out again.
//
// A symlink rather than a copy, which is how GSConnect does it: the link is
// made once and every extension update is picked up on the next Nautilus
// start, with nothing to re-install. It also makes ownership legible — the
// link names the extension directory it came from, so `ls -l` says who put
// it there and `uninstall` can tell our entry from a file it must not touch.
//
// nautilus-python reads three directories, in order: $XDG_DATA_HOME, the
// Nautilus prefix, and $XDG_DATA_DIRS. Only the first is ours to write, and
// a sandboxed file manager has its own $XDG_DATA_HOME — hence the list of
// candidates below rather than one path.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SCRIPT = 'tailscale-taildrop.py';

// The loader that runs a python file-manager extension. Our file is inert
// without it, so this is what the preferences ask about before offering the
// integration at all.
//
// The probe is for the module, not the package: there is no package manager
// every distribution answers, and the module is a Nautilus extension, so it
// lands in the file manager's own extension directory. What varies is the
// libdir above it. `/usr/share/nautilus-python/` is deliberately not probed —
// it survives an uninstall on at least Fedora, where it belongs to no
// package at all, and would report the loader present long after it went.
const LOADER = 'libnautilus-python.so';
const LOADER_DIRS = [
    '/usr/lib64', '/usr/lib', '/usr/local/lib64', '/usr/local/lib',
    // Debian and Ubuntu put extension modules under a multiarch triplet.
    '/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu',
    '/usr/lib/i386-linux-gnu', '/usr/lib/arm-linux-gnueabihf',
    '/usr/lib/riscv64-linux-gnu',
];

// The Scripts-submenu entries this replaces. Purged on enable so a user
// coming from 0.2.x does not end up with both, one of them dead.
const LEGACY_SCRIPTS = ['Send with Taildrop', 'Send with Taildrop as ZIP'];

function _exists(path) {
    return Gio.File.new_for_path(path).query_exists(null);
}

/**
 * Is nautilus-python installed?
 *
 * A false answer is the one that costs something — the preferences grey the
 * switch out on it — so the list of libdirs above errs wide. Nautilus 43
 * moved to the 4.x extension ABI and this extension needs Shell 49, so only
 * `extensions-4` is worth looking in.
 *
 * @returns {boolean} true when the loader module is on disk
 */
export function hasPythonLoader() {
    return LOADER_DIRS.some((dir) => _exists(
        GLib.build_filenamev([dir, 'nautilus', 'extensions-4', LOADER])));
}

// Where a given file manager install looks for python extensions. Each entry
// is only offered when there is evidence that flavour is present: creating
// ~/snap or ~/.var/app for a file manager nobody installed would leave litter
// behind that never gets read.
function _candidateDirs() {
    const home = GLib.get_home_dir();
    const dirs = [];

    // Distro package. Always a candidate: this is where nautilus-python
    // itself points, and the directory is ours whether Nautilus is installed
    // yet or not.
    dirs.push({
        kind: 'system',
        path: GLib.build_filenamev([
            GLib.get_user_data_dir(), 'nautilus-python', 'extensions',
        ]),
    });

    // Flatpak. The sandbox rewrites XDG_DATA_HOME to the app's own data
    // directory, so the system path above is invisible from inside it. The
    // app data dir only appears on first run, so the exported desktop entry
    // (user and system installs both) is what says "installed but never
    // launched".
    const flatpakEvidence = [
        GLib.build_filenamev([home, '.var', 'app', 'org.gnome.Nautilus']),
        GLib.build_filenamev([
            GLib.get_user_data_dir(), 'flatpak', 'exports', 'share',
            'applications', 'org.gnome.Nautilus.desktop',
        ]),
        '/var/lib/flatpak/exports/share/applications/org.gnome.Nautilus.desktop',
    ];
    if (flatpakEvidence.some(_exists)) {
        dirs.push({
            kind: 'flatpak',
            path: GLib.build_filenamev([
                home, '.var', 'app', 'org.gnome.Nautilus', 'data',
                'nautilus-python', 'extensions',
            ]),
        });
    }

    // Snap. Confinement remaps HOME to $SNAP_USER_DATA, so XDG_DATA_HOME
    // lands under ~/snap/<name>/current. `current` is snapd's own symlink to
    // the live revision, which is what keeps the link valid across refreshes.
    const snapDir = GLib.build_filenamev([home, 'snap', 'nautilus']);
    if (_exists(snapDir)) {
        dirs.push({
            kind: 'snap',
            path: GLib.build_filenamev([
                snapDir, 'current', '.local', 'share',
                'nautilus-python', 'extensions',
            ]),
        });
    }

    return dirs;
}

// Our link, or something else wearing the same name? Answers null when the
// entry is absent, so a caller can tell "nothing there" from "not ours".
function _linkTarget(file) {
    try {
        const info = file.query_info(
            'standard::is-symlink,standard::symlink-target',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null,
        );
        return info.get_is_symlink() ? info.get_symlink_target() : '';
    } catch {
        return null;
    }
}

function _isOurs(target) {
    return !!target && target.endsWith(GLib.build_filenamev(['nautilus', SCRIPT]));
}

/**
 * Link the Nautilus extension into every file manager flavour present.
 *
 * Best-effort by design: a directory that cannot be created (a read-only
 * home, a snap revision mid-refresh) is skipped with a warning rather than
 * failing the others, and none of it is allowed to break enable().
 *
 * @param {string} extensionPath - the extension's own directory
 * @returns {string[]} the paths that now carry the link
 */
export function install(extensionPath) {
    const target = GLib.build_filenamev([extensionPath, 'nautilus', SCRIPT]);
    const linked = [];

    for (const { kind, path } of _candidateDirs()) {
        const link = Gio.File.new_for_path(GLib.build_filenamev([path, SCRIPT]));
        const existing = _linkTarget(link);

        // Already pointing at us: nothing to do, and nothing to churn on
        // every screen unlock.
        if (existing === target) {
            linked.push(link.get_path());
            continue;
        }

        try {
            if (GLib.mkdir_with_parents(path, 0o755) !== 0)
                throw new Error(`cannot create ${path}`);

            // A symlink under our own name is ours to re-point: it is a
            // target gone stale, which is what an extension directory that
            // moved leaves behind. A regular file is not — the name is
            // namespaced to this project, so a real file there was put there
            // by hand and outranks us.
            if (existing !== null) {
                if (existing === '') {
                    console.warn(
                        `tailscale-gnome: ${link.get_path()} is a real file, not our link — leaving it`,
                    );
                    continue;
                }
                link.delete(null);
            }

            link.make_symbolic_link(target, null);
            linked.push(link.get_path());
        } catch (e) {
            console.warn(
                `tailscale-gnome: Nautilus (${kind}) link failed: ${e.message}`,
            );
        }
    }

    return linked;
}

/**
 * Remove the links again. Only ever deletes a symlink that resolves to this
 * extension's own script, so a file the user owns survives a disable().
 *
 * @param {string} extensionPath - the extension's own directory, unused
 *   beyond symmetry with install(); ownership is read off the link itself so
 *   a link left by an older install path is still cleaned up.
 */
export function uninstall(extensionPath) {
    void extensionPath;

    for (const { kind, path } of _candidateDirs()) {
        const link = Gio.File.new_for_path(GLib.build_filenamev([path, SCRIPT]));
        const existing = _linkTarget(link);

        if (existing === null || !_isOurs(existing))
            continue;

        try {
            link.delete(null);
        } catch (e) {
            console.warn(
                `tailscale-gnome: Nautilus (${kind}) unlink failed: ${e.message}`,
            );
        }
    }
}

/**
 * Drop the 0.2.x Scripts-submenu entries.
 *
 * Runs whether the integration is on or off, and once they are gone it is a
 * pair of query_exists calls: the entries were installed under these exact
 * names by this extension's own preferences window, so there is no one else
 * they could belong to. Leaving them would show two Taildrop paths, only one
 * of which still leads anywhere.
 */
export function purgeLegacyScripts() {
    const dir = GLib.build_filenamev([
        GLib.get_user_data_dir(), 'nautilus', 'scripts',
    ]);

    for (const name of LEGACY_SCRIPTS) {
        const file = Gio.File.new_for_path(GLib.build_filenamev([dir, name]));

        try {
            const info = file.query_info(
                'standard::type',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                null,
            );
            if (info.get_file_type() !== Gio.FileType.REGULAR)
                continue;
            file.delete(null);
        } catch {
            // Absent, which is the common case after the first run.
        }
    }
}
