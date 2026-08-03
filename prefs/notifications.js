// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// The Notifications page: how much each kind of event may report.

import Adw from "gi://Adw";
import Gio from "gi://Gio";
import Gtk from "gi://Gtk";

import { gettext as _ } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

// Pure module, no Shell imports: importing it here is what keeps the mode
// nicks and the category-to-key map from drifting between the two processes.
import { CATEGORY_KEY, NotifyMode } from "../lib/notify-policy.js";
import { resetButton, watchSetting } from "./common.js";

// Every event the extension can report, in the order they appear in the
// page. Keys match CATEGORY_KEY in lib/notify-policy.js.
// Titles/subtitles are deferred behind a closure (same convention as
// AVAILABILITY_DEFS above) because this array is built at module-import time,
// before the sandboxed prefs loader has an extension context to resolve
// gettext against. Calling _() here directly throws "gettext can only be
// called from extensions"; def.title()/def.subtitle() are only invoked
// later, from inside makeNotificationsPage().
const NOTIFY_DEFS = [
    {
        key: "notify-connection",
        title: () => _("Tailscale connection"),
        subtitle: () => _("Connecting, disconnecting, and daemon startup."),
    },
    {
        key: "notify-account",
        title: () => _("Login and logout"),
        subtitle: () => _("Sign-in, sign-out, and operator changes."),
    },
    {
        key: "notify-profile-switch",
        title: () => _("Profile switch"),
        subtitle: () =>
            _("A single notification once the new profile is applied."),
    },
    {
        key: "notify-exit-node",
        title: () => _("Exit node"),
        subtitle: () => _("Selection, going offline, and automatic switches."),
    },
    {
        key: "notify-network",
        title: () => _("Network settings"),
        subtitle: () =>
            _("Magic DNS, routes, shields up, SSH server, LAN access."),
    },
    {
        key: "notify-taildrop",
        title: () => _("Taildrop"),
        subtitle: () =>
            _("Files sent and received, receiver started and stopped."),
    },
    {
        key: "notify-funnel",
        title: () => _("Funnel"),
        subtitle: () => _("Ports added and removed."),
    },
    {
        key: "notify-errors",
        title: () => _("Errors"),
        subtitle: () => _("Failures outside any category above."),
    },
    {
        key: "notify-misc",
        title: () => _("Other"),
        subtitle: () => _("Clipboard copies and manual refreshes."),
    },
];

// The three-way control every event row carries, replacing the on/off
// switch and the single global failures override that used to sit beside
// it. Labels are terse on purpose: ten of these stack down the page and a
// homogeneous group is as wide as its widest toggle, so a long middle label
// would push the whole column out.
function _makeModeToggleGroup() {
    const group = new Adw.ToggleGroup({ valign: Gtk.Align.CENTER });
    group.add(
        new Adw.Toggle({
            name: NotifyMode.ALL,
            label: _("All"),
            tooltip: _("Report everything this category produces"),
        }),
    );
    group.add(
        new Adw.Toggle({
            name: NotifyMode.ERRORS,
            label: _("Errors"),
            tooltip: _("Report only failures and warnings"),
        }),
    );
    group.add(
        new Adw.Toggle({
            name: NotifyMode.OFF,
            label: _("Off"),
            tooltip: _("Report nothing at all"),
        }),
    );
    return group;
}

function _makeNotifyModeRow(settings, def) {
    const row = new Adw.ActionRow({
        title: def.title(),
        subtitle: def.subtitle(),
    });
    const group = _makeModeToggleGroup();
    // The key is an enum of the same three nicks, so this is a plain
    // string-to-string binding: no mapping functions, and an out-of-range
    // dconf value can never reach the widget.
    settings.bind(
        def.key,
        group,
        "active-name",
        Gio.SettingsBindFlags.DEFAULT,
    );
    row.add_suffix(group);
    row.add_suffix(resetButton(settings, def.key));
    return row;
}

// Quick access at the top of the list: one control that drives all of them.
// It has no key of its own: it reads the categories back, and shows a mode
// only while every one of them agrees on it. Once they differ it goes blank
// rather than picking a winner, because there is no honest answer to show.
function _makeAllEventsRow(settings) {
    const keys = Object.values(CATEGORY_KEY);
    const row = new Adw.ActionRow({
        title: _("All events"),
        subtitle: _("Apply one setting to every category below."),
    });
    const group = _makeModeToggleGroup();

    // Guards the loop both ways: writing the keys re-enters through their
    // `changed::` handlers, and sync() writing the widget re-enters through
    // notify::active-name.
    let syncing = false;

    const sync = () => {
        if (syncing) return;
        const modes = new Set(keys.map((k) => settings.get_string(k)));
        syncing = true;
        group.set_active_name(modes.size === 1 ? [...modes][0] : null);
        syncing = false;
    };

    group.connect("notify::active-name", () => {
        if (syncing) return;
        const mode = group.active_name;
        // Null means sync() blanked it for a mixed list, not a click. There
        // is nothing to apply, and applying "" would clear nine keys.
        if (!mode) return;
        syncing = true;
        for (const k of keys) settings.set_string(k, mode);
        syncing = false;
    });

    for (const k of keys) watchSetting(row, settings, k, sync);
    sync();

    row.add_suffix(group);
    // Resets the nine category keys only, not the whole page, and not the
    // pending-duration spinner above it.
    row.add_suffix(resetButton(settings, keys));
    return row;
}

export function makeNotificationsPage(settings) {
    const page = new Adw.PreferencesPage({
        title: _("Notifications"),
        iconName: "preferences-system-notifications-symbolic",
    });

    /* ---------------------------- Presentation --------------------------- */
    const modeGroup = new Adw.PreferencesGroup({
        title: _("Presentation"),
        description: _(
            "Reports post as native GNOME notifications, stacking into a " +
                "browsable history under a single Tailscale entry. How long " +
                "a banner stays on screen is GNOME's own setting, not this " +
                "extension's.",
        ),
    });
    page.add(modeGroup);

    const spinnerRow = new Adw.SpinRow({
        title: _("Minimum pending duration"),
        subtitle: _(
            "Milliseconds the pending state stays visible before showing the result (0 to 3000). Prevents flicker on instant actions.",
        ),
        adjustment: new Gtk.Adjustment({
            lower: 0,
            upper: 3000,
            step_increment: 100,
            page_increment: 500,
        }),
    });
    settings.bind(
        "min-pending-duration",
        spinnerRow,
        "value",
        Gio.SettingsBindFlags.DEFAULT,
    );
    spinnerRow.add_suffix(resetButton(settings, "min-pending-duration"));
    modeGroup.add(spinnerRow);

    /* ------------------------------ Events ------------------------------- */
    const eventsGroup = new Adw.PreferencesGroup({
        title: _("Events"),
        description: _(
            "How much each kind of event may report. All lets everything through, Errors keeps only failures and warnings, Off silences the category completely.",
        ),
    });
    page.add(eventsGroup);

    eventsGroup.add(_makeAllEventsRow(settings));
    for (const def of NOTIFY_DEFS)
        eventsGroup.add(_makeNotifyModeRow(settings, def));

    return page;
}
