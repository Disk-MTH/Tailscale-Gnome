// Preferences dialog — Adwaita-based, GNOME 46+.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ }
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class TailscaleGnomePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            iconName: 'preferences-system-symbolic',
        });
        window.add(page);

        /* ---------------------------- Polling --------------------------- */
        const polling = new Adw.PreferencesGroup({
            title: _('Polling'),
            description: _('How often the extension calls `tailscale status` to refresh.'),
        });
        page.add(polling);

        const pollRow = new Adw.SpinRow({
            title: _('Poll interval'),
            subtitle: _('Seconds between status refreshes (2 – 60).'),
            adjustment: new Gtk.Adjustment({
                lower: 2, upper: 60, step_increment: 1, page_increment: 5,
            }),
        });
        settings.bind('poll-interval', pollRow, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        polling.add(pollRow);

        /* --------------------------- Indicator -------------------------- */
        const indicator = new Adw.PreferencesGroup({
            title: _('Panel Indicator'),
            description: _('Small Tailscale icon shown next to Wi-Fi.'),
        });
        page.add(indicator);

        const showRow = new Adw.SwitchRow({
            title: _('Show indicator'),
            subtitle: _('Show the Tailscale icon while connected.'),
        });
        settings.bind('show-indicator', showRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        indicator.add(showRow);

        const alwaysRow = new Adw.SwitchRow({
            title: _('Always visible'),
            subtitle: _('Show the icon even when Tailscale is stopped.'),
        });
        settings.bind('indicator-always-visible', alwaysRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        indicator.add(alwaysRow);

        /* ------------------------- Quick Settings ----------------------- */
        const tile = new Adw.PreferencesGroup({
            title: _('Quick Settings tile'),
        });
        page.add(tile);

        const subtitleRow = new Adw.SwitchRow({
            title: _('Show subtitle'),
            subtitle: _('Display the connected account or status under the title.'),
        });
        settings.bind('show-subtitle', subtitleRow, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        tile.add(subtitleRow);

        /* ---------------------------- Binary ---------------------------- */
        const advanced = new Adw.PreferencesGroup({
            title: _('Advanced'),
        });
        page.add(advanced);

        const binaryRow = new Adw.EntryRow({
            title: _('tailscale binary'),
        });
        settings.bind('tailscale-binary', binaryRow, 'text',
            Gio.SettingsBindFlags.DEFAULT);
        advanced.add(binaryRow);
    }
}
