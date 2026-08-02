// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// Preferences entry point. Each page owns its own file under prefs/ — the
// preferences process loads none of the shell-side modules, and keeping
// them in their own directory is what says so at a glance.

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import { makeGeneralPage } from "./prefs/general.js";
import { makeHelpPage } from "./prefs/help.js";
import { makeNotificationsPage } from "./prefs/notifications.js";
import { makeShortcutsPage } from "./prefs/shortcuts.js";

export default class TailscaleGnomePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // The shell opens this at a size that leaves the four page titles
        // fighting for the header, and "Notifications" loses — it comes up
        // elided to "Notifi…". Wide enough for all four spelled out, and
        // for the longest of them in French and German too.
        window.set_default_size(820, 700);

        window.add(makeGeneralPage(settings));
        window.add(makeNotificationsPage(settings));
        window.add(makeShortcutsPage(settings));
        window.add(makeHelpPage(settings, this.metadata));
    }
}
