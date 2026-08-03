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

// What the shell's last poll saw, as far as this process can tell. The
// mirror can be stale — the extension may be disabled, and then nothing is
// polling — but a PATH walk cannot, and that is the case worth being right
// about: a window that hid its pages on a key written last week would be a
// bug with no visible cause.
export function readBackendStatus(settings) {
    if (!hasTailscaleCli()) return "not-installed";
    return settings.get_string("backend-status");
}

// Shown at the top of the pages that survive while the backend cannot be
// driven. The rows below it are left alone on purpose: they are the
// *extension's* preferences — which indicators to draw, what to notify
// about, which keys to bind — and they stay meaningful either way. What is
// dead in that state lives in the shell menu, and the menu says so itself.
// The one thing this group cannot do is act: installing a package and
// starting a service are the distribution's business, not a button here.
//
// It hides itself rather than not existing, so the same instance can follow
// the key through an install or a `systemctl start` without the page it
// sits on being rebuilt around it.
export function makeBackendGroup(settings) {
    const group = new Adw.PreferencesGroup();
    const row = new Adw.ActionRow();
    row.add_prefix(
        new Gtk.Image({
            iconName: "dialog-warning-symbolic",
            valign: Gtk.Align.CENTER,
        }),
    );
    group.add(row);

    const sync = () => {
        const status = readBackendStatus(settings);
        group.visible = status !== "ready";
        if (status === "ready") return;
        if (status === "not-installed") {
            row.title = _("Tailscale is not installed");
            row.subtitle = _(
                "The `tailscale` command was not found on PATH, so the menu has " +
                    "nothing to drive. Install it with your distribution's " +
                    "package manager; the extension picks it up on its own, " +
                    "with no reload.",
            );
            return;
        }
        row.title = _("Tailscale is not running");
        row.subtitle = _(
            "The `tailscale` command is there, but the tailscaled daemon does " +
                "not answer, so the menu has nothing to drive. Start it with " +
                "`systemctl enable --now tailscaled`; the extension picks it " +
                "up on its own, with no reload.",
        );
    };
    watchSetting(group, settings, "backend-status", sync);
    sync();
    return group;
}
