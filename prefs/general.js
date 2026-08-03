// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// The General (landing) page: panel indicators, the Taildrop group, and
// the advanced knobs — plus the global reset that belongs with them.

import Adw from "gi://Adw";
import Gdk from "gi://Gdk";
import Gio from "gi://Gio";
import Gtk from "gi://Gtk";

import { gettext as _ } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import { spawn as _spawn } from "../lib/util.js";
import { makeBackendGroup, resetButton, watchSetting } from "./common.js";
import { makeTaildropGroup } from "./taildrop.js";

const TAILSCALED_UNIT = "tailscaled.service";

async function _serviceEnabled() {
    const r = await _spawn(["systemctl", "is-enabled", TAILSCALED_UNIT]);
    // systemctl is-enabled prints "enabled" / "disabled" / "static" / etc.
    const out = r.stdout.trim();
    return {
        available: r.code !== 4,
        enabled: out === "enabled" || out === "enabled-runtime",
    };
}

// Adw.SwitchRow is `final` in libadwaita 1.4+, so we can't subclass it. Build
// one and wire the systemctl toggle externally instead.
function _makeServiceRow() {
    const row = new Adw.SwitchRow({
        title: _("Start Tailscale at boot"),
        subtitle: _("Enables tailscaled.service via systemctl."),
    });

    let guard = false;

    const refresh = async () => {
        const { available, enabled } = await _serviceEnabled();
        row.sensitive = available;
        guard = true;
        row.active = enabled;
        guard = false;
        if (!available)
            row.subtitle = _(
                "tailscaled.service not found. Install Tailscale via your distribution.",
            );
    };

    const toggle = async (enable) => {
        // Fixed argument vector of system binaries only — no user-writable
        // path is ever elevated. Listed in README under "Privileged
        // operations".
        const argv = [
            "pkexec",
            "systemctl",
            enable ? "enable" : "disable",
            "--now",
            TAILSCALED_UNIT,
        ];
        const r = await _spawn(argv);
        if (!r.ok) {
            guard = true;
            row.active = !enable;
            guard = false;
            row.get_root().add_toast(
                new Adw.Toast({
                    title: _("Could not change service state"),
                    timeout: 4,
                }),
            );
        }
        refresh();
    };

    row.connect("notify::active", () => {
        if (guard) return;
        toggle(row.active);
    });

    refresh();
    return row;
}

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
// no way to draw "none", so it shows white as a stand-in and the subtitle
// says which of the two is in force — picking a colour opts in, the reset
// suffix opts back out.
function _makeIndicatorColorRow(settings, def) {
    const row = new Adw.ActionRow({ title: def.title() });

    const button = new Gtk.ColorDialogButton({
        // No alpha: the value ends up as a CSS colour on a symbolic icon,
        // where a translucent ink would just look like a rendering fault.
        dialog: new Gtk.ColorDialog({ with_alpha: false }),
        valign: Gtk.Align.CENTER,
    });
    const fallback = def.themeDefault
        ? THEME_COLOR_PLACEHOLDER
        : DEFAULT_WARN_COLOR;
    const read = () => settings.get_string(def.key);
    const syncSubtitle = () => {
        row.subtitle = def.subtitle(_isHexColor(read()));
    };

    // Guard against the loop: writing the key re-enters this handler via
    // the `changed::` subscription below. The subtitle is refreshed either
    // way round, so it stays right whichever end the change came from.
    let syncing = false;
    button.connect("notify::rgba", () => {
        if (syncing) return;
        syncing = true;
        settings.set_string(def.key, _formatColor(button.get_rgba()));
        syncing = false;
        syncSubtitle();
    });

    watchSetting(row, settings, def.key, () => {
        syncSubtitle();
        if (syncing) return;
        syncing = true;
        button.set_rgba(_parseColor(read(), fallback));
        syncing = false;
    });

    button.set_rgba(_parseColor(read(), fallback));
    syncSubtitle();

    row.add_suffix(button);
    row.add_suffix(resetButton(settings, def.key));
    return row;
}

export function makeGeneralPage(settings) {
    const page = new Adw.PreferencesPage({
        title: _("General"),
        iconName: "preferences-system-symbolic",
    });

    // Only ever seen when the mirror is stale — this page is not in the
    // window at all while the backend is down. That is exactly when it
    // earns its place: with the extension disabled nothing is polling, and
    // the PATH walk behind the group is the only thing still telling the
    // truth about a `tailscale` that has gone.
    page.add(makeBackendGroup(settings));

    /* --------------------------- Indicators ------------------------- */
    // Three independent switches rather than one: the exit-node warning
    // is the only sign that the device has no internet, so someone who
    // hides the connection icon to keep the panel quiet must still be
    // able to keep the warning, and the pair of exit-node icons — routing
    // and not routing — is worth keeping together rather than tying to
    // the connection icon.
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

    const exitActiveRow = new Adw.SwitchRow({
        title: _("Show exit node active panel indicator"),
        subtitle: _(
            "VPN icon shown while an exit node is selected and routing traffic.",
        ),
    });
    settings.bind(
        "show-exit-node-active-indicator",
        exitActiveRow,
        "active",
        Gio.SettingsBindFlags.DEFAULT,
    );
    exitActiveRow.add_suffix(
        resetButton(settings, "show-exit-node-active-indicator"),
    );
    indicators.add(exitActiveRow);

    indicators.add(
        _makeIndicatorColorRow(settings, {
            key: "exit-node-active-indicator-color",
            title: () => _("Exit node active indicator colour"),
            themeDefault: true,
            subtitle: (custom) =>
                custom
                    ? _("Custom colour. Reset to follow the theme again.")
                    : _("Follows the panel's own colour, light or dark."),
        }),
    );

    const exitIndicatorRow = new Adw.SwitchRow({
        title: _("Show exit node status panel indicator"),
        subtitle: _(
            "Warning icon shown when the selected exit node cannot route, which leaves the device without internet access.",
        ),
    });
    settings.bind(
        "show-exit-node-indicator",
        exitIndicatorRow,
        "active",
        Gio.SettingsBindFlags.DEFAULT,
    );
    exitIndicatorRow.add_suffix(
        resetButton(settings, "show-exit-node-indicator"),
    );
    indicators.add(exitIndicatorRow);

    indicators.add(
        _makeIndicatorColorRow(settings, {
            key: "exit-node-indicator-color",
            title: () => _("Exit node indicator colour"),
            subtitle: () => _("Colour of the warning icon in the top bar."),
        }),
    );

    /* ----------------------------- Taildrop ------------------------- */
    page.add(makeTaildropGroup(settings));

    /* ---------------------------- Advanced -------------------------- */
    const advanced = new Adw.PreferencesGroup({
        title: _("Advanced"),
    });
    page.add(advanced);

    // The systemd unit toggle isn't a GSettings key, so no reset
    // suffix; the system manages its own state.
    advanced.add(_makeServiceRow());

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
