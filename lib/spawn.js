// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// The only module in this extension that starts a process.
//
// `grep -rn 'Gio.Subprocess' lib prefs extension.js prefs.js` returns this
// file and nothing else, on purpose: every command the extension can run,
// privileged or not, one-shot or long-lived, is launched from one of the
// three functions below. Callers pass the argument vector and read the
// result; none of them constructs a subprocess of its own.
//
// Shared by both processes (the GNOME Shell one and the preferences one),
// so only process-neutral imports are allowed: no St/Clutter/Meta/Shell,
// no Gtk/Adw.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// The one and only program name this extension ever runs. Not
// configurable, and deliberately so: the privileged calls must stay
// literal argument vectors for review, and a setting that only steered
// the unprivileged half would mean half the extension talking to a
// different binary than the other half.
export const TAILSCALE_BIN = 'tailscale';

// Every privileged call is `pkexec <path>/tailscale …`: one polkit prompt,
// an argument vector a reviewer can read at a glance, and never a shell.
export const PKEXEC_BIN = 'pkexec';

// Directories a Tailscale may be elevated from, and the fallback list
// searched when it is nowhere on $PATH. Fixed, in the source rather than in
// a setting, and every entry is a directory only root can write on the
// systems that have one: that is what makes a path found here safe to hand
// to pkexec.
//
// The list exists because "wherever `tailscale` is" is not an answer pkexec
// can use. pkexec does not inherit the caller's environment; it resolves a
// bare program name in its own root PATH, so on a distribution that does
// not keep its tools in /usr/bin (NixOS and Guix build a system profile
// instead) the elevated half of the extension ends up looking somewhere
// else than the unelevated half, and finds either nothing or the wrong
// program. Resolving the path here and passing it whole is what keeps the
// two halves on the same binary.
const SYSTEM_BIN_DIRS = [
    '/usr/bin',                         // distribution packages
    '/usr/local/bin',                   // tailscale.com's install script
    '/bin', '/usr/sbin', '/sbin',       // pre-merged-/usr layouts
    '/run/current-system/sw/bin',       // NixOS, system-wide
    '/run/current-system/profile/bin',  // Guix, system-wide
    `/etc/profiles/per-user/${GLib.get_user_name()}/bin`,  // NixOS, per-user
    '/opt/tailscale/bin',               // vendor tarball
];

// First SYSTEM_BIN_DIRS entry that holds an executable CLI, or null.
function _systemTailscaleBin() {
    for (const dir of SYSTEM_BIN_DIRS) {
        const path = `${dir}/${TAILSCALE_BIN}`;
        if (GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE))
            return path;
    }
    return null;
}

/**
 * Absolute path of the CLI to run for ordinary, unprivileged commands, or
 * null when this machine has no Tailscale at all.
 *
 * $PATH first, because the CLI the user's own shell runs is the one whose
 * answers the menu should be showing, and because that is what keeps an
 * install outside the system directories (~/.local/bin and the like)
 * working for everything that does not need root.
 *
 * @returns {string|null}
 */
export function tailscaleBin() {
    return GLib.find_program_in_path(TAILSCALE_BIN);
}

/**
 * Absolute path of the CLI to run as root, or null when the only Tailscale
 * on this machine sits outside SYSTEM_BIN_DIRS.
 *
 * Deliberately narrower than tailscaleBin(): $PATH belongs to the session,
 * so elevating whatever it resolves to would hand a root shell to anything
 * able to prepend a directory to it. A Tailscale found outside the system
 * directories is run as the user who owns it and never as root; callers
 * report that rather than elevate it.
 *
 * @returns {string|null}
 */
export function privilegedTailscaleBin() {
    const onPath = tailscaleBin();
    if (onPath && SYSTEM_BIN_DIRS.includes(GLib.path_get_dirname(onPath)))
        return onPath;
    return _systemTailscaleBin();
}

/**
 * Whether the Tailscale CLI exists at all, a different question from "the
 * daemon is not answering", and one that deserves a different answer on
 * screen: there is nothing to answer with, so every control that drives a
 * command is dead until a package is installed.
 *
 * Lives here because both processes must agree on it: the shell hides the
 * menu, the preferences say why. It is a PATH walk rather than a spawn,
 * cheap enough for the shell to redo on every poll and never cached, which
 * is what lets the extension come back on its own, with no reload, the
 * moment Tailscale is installed.
 *
 * @returns {boolean}
 */
export function hasTailscaleCli() {
    return tailscaleBin() !== null;
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
export function run(argv, cancellable = null) {
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
 * Start a child the caller stays attached to instead of waiting for it to
 * exit, and hand back the process itself: three commands need that, and
 * each drives it differently. Login watches both pipes for the auth URL,
 * the funnel publish watches for the not-enabled notice, and the Taildrop
 * receiver watches for arrivals; all three also want wait_async() and, in
 * one case, force_exit(). Both pipes are opened because the CLI is not
 * consistent about which one it prints to.
 *
 * Throws, like Gio.Subprocess.new does, when the program is not on PATH.
 * Callers turn that into their own failure shape.
 *
 * @param {string[]} argv
 * @returns {Gio.Subprocess}
 */
export function runStreaming(argv) {
    return Gio.Subprocess.new(
        argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    );
}

/**
 * Start a child in a chosen directory, optionally with extra environment.
 * Only the Taildrop archiver needs this: `zip` records paths relative to
 * its working directory, and the password goes through ZIPOPT rather than
 * the command line, where every user on the machine could read it.
 *
 * stdout is dropped (the archiver has nothing to say on success) and
 * stderr kept for the failure message.
 *
 * @param {string[]} argv
 * @param {{cwd?: string, env?: Object<string, string>}} [options]
 * @returns {Gio.Subprocess}
 */
export function runInDir(argv, { cwd = null, env = null } = {}) {
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDOUT_SILENCE |
               Gio.SubprocessFlags.STDERR_PIPE,
    });
    if (cwd) launcher.set_cwd(cwd);
    if (env) {
        for (const [key, value] of Object.entries(env))
            launcher.setenv(key, value, true);
    }
    return launcher.spawnv(argv);
}

/**
 * Hand every line a subprocess pipe produces to onLine.
 *
 * Reading stops at EOF, when the stream closes, when the cancellable
 * fires, and when onLine returns false.
 *
 * @param {Gio.InputStream} stream
 * @param {Gio.Cancellable|null} cancellable
 * @param {(line: string) => boolean|void} onLine false to stop reading
 */
export function readLines(stream, cancellable, onLine) {
    const dis = new Gio.DataInputStream({
        base_stream: stream, close_base_stream: true,
    });
    const loop = () => {
        dis.read_line_async(GLib.PRIORITY_DEFAULT, cancellable,
            (obj, res) => {
                let line;
                try {
                    [line] = obj.read_line_finish_utf8(res);
                } catch {
                    return;  // cancelled or stream closed
                }
                if (line === null) return;   // EOF
                if (onLine(line) !== false) loop();
            });
    };
    loop();
}
