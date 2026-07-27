// Helpers shared between the GNOME Shell process (extension.js, lib/) and
// the preferences process (prefs.js). Only process-neutral imports are
// allowed here: no St/Clutter/Meta/Shell, no Gtk/Adw.

import Gio from 'gi://Gio';

// Node capabilities the daemon publishes in `status --json` Self.CapMap.
// The shell process reads them on every availability probe; the prefs
// process reads the same keys behind the per-feature Check buttons, so
// both always agree on what the tailnet allows.
export const CAP_FILE_SHARING = 'https://tailscale.com/cap/file-sharing';
export const CAP_FUNNEL = 'funnel';

/**
 * Run a child process asynchronously and resolve with
 * { ok, code, stdout, stderr }. Never throws on a non-zero exit — callers
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
 * Whether the daemon's capability map grants `cap` to this node — or `null`
 * when the question could not be answered at all. `null` covers: `status
 * --json` exiting non-zero (logged out, daemon stopped, daemon restarting),
 * stdout that failed to parse, and a daemon too old to publish
 * `Self.CapMap`. Only a genuine `true`/`false` reflects what the tailnet's
 * admin allows; `null` must never be cached as a negative answer, exactly as
 * `TailscaleClient.probeAvailability` leaves its cached flags untouched on
 * the same three conditions so a transient hiccup doesn't grey out the UI.
 * Shared by the shell-side startup probe and the prefs Check buttons so a
 * manual check can never disagree with the automatic one.
 *
 * @param {string} bin  tailscale binary
 * @param {string} cap  capability key
 * @returns {Promise<boolean|null>}
 */
export async function hasCapability(bin, cap) {
    const r = await spawn([bin, 'status', '--json']);
    if (!r.ok) return null;
    let capMap;
    try {
        capMap = JSON.parse(r.stdout).Self?.CapMap;
    } catch {
        return null;
    }
    if (!capMap) return null;
    return Object.prototype.hasOwnProperty.call(capMap, cap);
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
 * Gio.Icon for one of the extension's bundled SVG icons.
 *
 * @param {import('resource:///org/gnome/shell/extensions/extension.js').Extension} extension
 * @param {string} name  basename without extension, e.g. "tailscale-symbolic"
 * @returns {Gio.FileIcon}
 */
export function gicon(extension, name) {
    return new Gio.FileIcon({
        file: extension.dir.get_child('icons').get_child(`${name}.svg`),
    });
}
