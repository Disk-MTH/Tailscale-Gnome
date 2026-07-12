// Helpers shared between the GNOME Shell process (extension.js, lib/) and
// the preferences process (prefs.js). Only process-neutral imports are
// allowed here: no St/Clutter/Meta/Shell, no Gtk/Adw.

import Gio from 'gi://Gio';

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
