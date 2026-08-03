// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// The General (landing) page: panel indicators, the Taildrop group, and
// the advanced knobs, plus the global reset that belongs with them.

import Adw from "gi://Adw";
import Gdk from "gi://Gdk";
import Gio from "gi://Gio";
import Gtk from "gi://Gtk";

import { gettext as _ } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import { spawn as _spawn } from "../lib/util.js";
import { makeBackendGroup, resetButton, watchSetting } from "./common.js";
import { makeTaildropGroup } from "./taildrop.js";

const DEFAULT_WARN_COLOR = "#e6b800";

// Only ever shown in the button of a row whose key is empty, to stand in
// for "whatever the panel paints it". Never written to GSettings.
const THEME_COLOR_PLACEHOLDER = "#ffffff";

function _isHexColor(value) {
    return /^#[0-9a-fA-F]{6}$/.test(value);
}

// GSettings stores the warning colour as a #rrggbb string, which is what
// the shell-side inline style needs; Gtk speaks Gdk.RGBA. These two convert
// between the pair, and _parseColor falls back rather than throwing so a
// hand-edited dconf value cannot leave the row unbuilt.
function _parseColor(hex, fallback = DEFAULT_WARN_COLOR) {
    const rgba = new Gdk.RGBA();
    if (!rgba.parse(_isHexColor(hex) ? hex : fallback))
        rgba.parse(DEFAULT_WARN_COLOR);
    return rgba;
}

function _formatColor(rgba) {
    const byte = (v) =>
        Math.round(Math.min(1, Math.max(0, v)) * 255)
            .toString(16)
            .padStart(2, "0");
    return `#${byte(rgba.red)}${byte(rgba.green)}${byte(rgba.blue)}`;
}

// Colour picker bound to a GSettings #rrggbb string.
//
// `themeDefault` marks a key whose default is no colour at all: the value
// is then empty, the shell leaves the icon in the panel's own ink, and it
// follows a light or dark theme without being told to. A colour button has
// no way to draw "none", so it shows white as a stand-in and says which of
// the two is in force in its tooltip: picking a colour opts in, the reset
// beside it opts back out.
function _makeIndicatorColorButton(settings, def) {
    const button = new Gtk.ColorDialogButton({
        // No alpha: the value ends up as a CSS colour on a symbolic icon,
        // where a translucent ink would just look like a rendering fault.
        dialog: new Gtk.ColorDialog({ with_alpha: false }),
        valign: Gtk.Align.CENTER,
    });
    const fallback = def.themeDefault
        ? THEME_COLOR_PLACEHOLDER
        : DEFAULT_WARN_COLOR;
    const read = () => settings.get_string(def.colorKey);
    const syncTooltip = () => {
        button.tooltip_text =
            def.themeDefault && !_isHexColor(read())
                ? _("Follows the panel colour. Pick one to override it.")
                : _("Icon colour");
    };

    // Guard against the loop: writing the key re-enters this handler via
    // the `changed::` subscription below. The tooltip is refreshed either
    // way round, so it stays right whichever end the change came from.
    let syncing = false;
    button.connect("notify::rgba", () => {
        if (syncing) return;
        syncing = true;
        settings.set_string(def.colorKey, _formatColor(button.get_rgba()));
        syncing = false;
        syncTooltip();
    });

    watchSetting(button, settings, def.colorKey, () => {
        syncTooltip();
        if (syncing) return;
        syncing = true;
        button.set_rgba(_parseColor(read(), fallback));
        syncing = false;
    });

    // Guarded like every other write to the button: this one is only
    // showing the stored value, and an unguarded set_rgba() emits
    // `notify::rgba` straight back into the handler above, which would
    // write the placeholder to a key whose default is "no colour", turning
    // "follows the theme" into a hard white the moment the window opened.
    syncing = true;
    button.set_rgba(_parseColor(read(), fallback));
    syncing = false;
    syncTooltip();
    return button;
}

// One row per exit-node state: whether the icon is drawn at all, and what
// colour it is drawn in, each with its own reset. The two belong together;
// the colour is meaningless without the icon it paints, and splitting them
// over two rows only made the group read as four unrelated settings.
function _makeExitNodeIndicatorRow(settings, def) {
    const row = new Adw.ActionRow({
        title: def.title,
        subtitle: def.subtitle,
    });

    const toggle = new Gtk.Switch({ valign: Gtk.Align.CENTER });
    settings.bind(
        def.showKey,
        toggle,
        "active",
        Gio.SettingsBindFlags.DEFAULT,
    );
    row.activatable_widget = toggle;

    row.add_suffix(toggle);
    row.add_suffix(resetButton(settings, def.showKey));
    row.add_suffix(
        new Gtk.Separator({
            orientation: Gtk.Orientation.VERTICAL,
            valign: Gtk.Align.CENTER,
            heightRequest: 20,
            marginStart: 6,
            marginEnd: 6,
        }),
    );
    row.add_suffix(_makeIndicatorColorButton(settings, def));
    row.add_suffix(resetButton(settings, def.colorKey));
    return row;
}

export function makeGeneralPage(settings) {
    const page = new Adw.PreferencesPage({
        title: _("General"),
        iconName: "preferences-system-symbolic",
    });

    // Only ever seen when the mirror is stale: this page is not in the
    // window at all while the backend is down. That is exactly when it
    // earns its place: with the extension disabled nothing is polling, and
    // the PATH walk behind the group is the only thing still telling the
    // truth about a `tailscale` that has gone.
    page.add(makeBackendGroup(settings));

    /* --------------------------- Indicators ------------------------- */
    // Three independent switches rather than one: the disconnected
    // exit-node icon is the only sign that the device has no internet, so
    // someone who hides the connection icon to keep the panel quiet must
    // still be able to keep that warning.
    const indicators = new Adw.PreferencesGroup({
        title: _("Indicators"),
        description: _("Icons shown in the top bar, next to Wi-Fi."),
    });
    page.add(indicators);

    const showRow = new Adw.SwitchRow({
        title: _("Show Tailscale panel indicator"),
        subtitle: _("Small Tailscale icon shown while connected."),
    });
    settings.bind(
        "show-indicator",
        showRow,
        "active",
        Gio.SettingsBindFlags.DEFAULT,
    );
    showRow.add_suffix(resetButton(settings, "show-indicator"));
    indicators.add(showRow);

    indicators.add(
        _makeExitNodeIndicatorRow(settings, {
            showKey: "show-exit-node-active-indicator",
            colorKey: "exit-node-active-indicator-color",
            themeDefault: true,
            title: _("Show exit node panel indicator: connected"),
            subtitle: _(
                "Icon shown while the exit node is routing your traffic.",
            ),
        }),
    );

    indicators.add(
        _makeExitNodeIndicatorRow(settings, {
            showKey: "show-exit-node-indicator",
            colorKey: "exit-node-indicator-color",
            title: _("Show exit node panel indicator: disconnected"),
            subtitle: _(
                "Icon shown when the exit node cannot route your traffic, " +
                    "leaving this device without internet.",
            ),
        }),
    );

    /* ----------------------------- Taildrop ------------------------- */
    page.add(makeTaildropGroup(settings));

    /* ---------------------------- Advanced -------------------------- */
    const advanced = new Adw.PreferencesGroup({
        title: _("Advanced"),
    });
    page.add(advanced);

    const pollRow = new Adw.SpinRow({
        title: _("Poll interval"),
        subtitle: _("Seconds between status refreshes (1 to 60)."),
        adjustment: new Gtk.Adjustment({
            lower: 1,
            upper: 60,
            step_increment: 1,
            page_increment: 5,
        }),
    });
    settings.bind(
        "poll-interval",
        pollRow,
        "value",
        Gio.SettingsBindFlags.DEFAULT,
    );
    pollRow.add_suffix(resetButton(settings, "poll-interval"));
    advanced.add(pollRow);

    /* ----------------------------- Reset all ------------------------ */
    // Global "reset everything" lives in its own group so it gets a
    // visual break from the dense list of settings above.
    const resetGroup = new Adw.PreferencesGroup();
    const resetAllRow = new Adw.ActionRow({
        title: _("Reset all settings"),
        subtitle: _("Restore every setting to its default, on all pages."),
    });
    const resetAllBtn = new Gtk.Button({
        label: _("Reset all"),
        valign: Gtk.Align.CENTER,
        css_classes: ["destructive-action"],
    });
    resetAllBtn.connect("clicked", async () => {
        // Reset all GSettings keys to their schema defaults.
        for (const k of settings.list_keys()) settings.reset(k);

        // Also apply the corresponding defaults to the Tailscale daemon
        // so the Quick Settings menu reflects the reset state:
        //   Magic DNS off, accept routes off, shields up off,
        //   SSH server off, exit node cleared, any active funnels
        //   torn down.
        try {
            await _spawn([
                "tailscale",
                "set",
                "--accept-dns=false",
                "--accept-routes=false",
                "--shields-up=false",
                "--ssh=false",
                "--exit-node=",
            ]);
        } catch {
            // Non-fatal: GSettings were reset regardless.
        }
        // `funnel reset` is its own subcommand; ignore failures (most
        // likely "no funnels to reset", which is exactly what we want).
        try {
            await _spawn(["tailscale", "funnel", "reset"]);
        } catch {}

        // The two availability keys were reset along with everything
        // else, and nothing here puts them back: the shell rewrites
        // them from its next poll, a second or two out. Probing them
        // here would only race that.

        resetGroup
            .get_root()
            .add_toast(
                new Adw.Toast({
                    title: _("All settings reset to defaults"),
                    timeout: 3,
                }),
            );
    });
    resetAllRow.add_suffix(resetAllBtn);
    resetGroup.add(resetAllRow);
    page.add(resetGroup);

    return page;
}
