// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// Preferences entry point. Each page owns its own file under prefs/: the
// preferences process loads none of the shell-side modules, and keeping
// them in their own directory is what says so at a glance.

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import { readBackendStatus, watchSetting } from "./prefs/common.js";
import { makeGeneralPage } from "./prefs/general.js";
import { makeHelpPage } from "./prefs/help.js";
import { makeNotificationsPage } from "./prefs/notifications.js";
import { makeShortcutsPage } from "./prefs/shortcuts.js";

export default class TailscaleGnomePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // The shell opens this at a size that leaves the four page titles
        // fighting for the header, and "Notifications" loses: it comes up
        // elided to "Notifi…". Wide enough for all four spelled out, and
        // for the longest of them in French and German too.
        window.set_default_size(820, 700);

        // Built once and moved in and out of the window from there.
        // Rebuilding them on every status change would leave the old pages'
        // `changed::` subscriptions connected to widgets nothing points at
        // any more: watchSetting drops them on 'destroy', and an unparented
        // page this process still holds a reference to is not destroyed.
        const pages = [
            makeGeneralPage(settings),
            makeNotificationsPage(settings),
            makeShortcutsPage(settings),
            makeHelpPage(settings, this.metadata),
        ];
        const help = pages[pages.length - 1];

        // With no backend to drive, three of these four pages configure a
        // menu that does not open. Help is the one whose whole job is
        // explaining a machine that is not working, so it is the one that
        // stays, and it carries the group that says which of the two
        // states this is.
        //
        // Removed and re-added rather than hidden: the window appends, so
        // taking Help out and putting all four back is the only way the
        // other three land ahead of it again.
        let shown = [];
        const populate = () => {
            for (const page of shown) window.remove(page);
            shown = readBackendStatus(settings) === "ready" ? pages : [help];
            for (const page of shown) window.add(page);
        };

        watchSetting(window, settings, "backend-status", populate);
        populate();
    }
}
