// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// Pieces every preference page reuses. Loaded only by the preferences
// process, like everything else in this directory.

import Adw from "gi://Adw";
import Gtk from "gi://Gtk";

import { gettext as _ } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import { hasTailscaleCli } from "../lib/util.js";

// This process has no signal tracker (connectObject lives in the Shell
// process), so every settings subscription needs its own disconnect. Tying
// the pair to the widget that reads the key keeps them on one line instead
// of two, several statements apart, at each of the call sites below.
export function watchSetting(widget, settings, key, handler) {
    const id = settings.connect(`changed::${key}`, handler);
    widget.connect("destroy", () => settings.disconnect(id));
}

// Per-row reset suffix: restores the GSettings key — or every key in the
// array — to its schema default. Uses `view-refresh-symbolic`; the
// availability check button uses `rotation-allowed-symbolic` to stay
// visually distinct from a reset.
export function resetButton(settings, key) {
    const keys = Array.isArray(key) ? key : [key];
    const btn = new Gtk.Button({
        icon_name: "view-refresh-symbolic",
        valign: Gtk.Align.CENTER,
        css_classes: ["flat"],
        tooltip_text: _("Reset to default"),
    });
    btn.connect("clicked", () => {
        for (const k of keys) settings.reset(k);
    });
    return btn;
}

// Shown at the top of every page while the CLI is missing. The rows below
// it are left alone on purpose: they are the *extension's* preferences —
// which indicators to draw, what to notify about, which keys to bind — and
// they stay meaningful whether or not Tailscale is installed. What is dead
// in that state lives in the shell menu, and the menu says so itself.
// The one thing this group cannot do is act: installing a package is the
// distribution's business, not a button here.
export function makeNotInstalledGroup() {
    if (hasTailscaleCli()) return null;
    const group = new Adw.PreferencesGroup();
    const row = new Adw.ActionRow({
        title: _("Tailscale is not installed"),
        subtitle: _(
            "The `tailscale` command was not found on PATH, so the menu has " +
                "nothing to drive. Install it with your distribution's " +
                "package manager; the extension picks it up on its own, " +
                "with no reload.",
        ),
    });
    row.add_prefix(
        new Gtk.Image({
            iconName: "dialog-warning-symbolic",
            valign: Gtk.Align.CENTER,
        }),
    );
    group.add(row);
    return group;
}
