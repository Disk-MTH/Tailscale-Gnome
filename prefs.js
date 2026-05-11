// Preferences dialog (Adwaita). GNOME 46+.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences, gettext as _ }
    from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const TAILSCALED_UNIT = 'tailscaled.service';

/* -------------------------------------------------------------------------- */
/*                            Subprocess helpers                              */
/* -------------------------------------------------------------------------- */

function _spawn(argv) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) { reject(e); return; }
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                resolve({
                    ok: p.get_successful(),
                    code: p.get_exit_status(),
                    stdout: stdout ?? '',
                    stderr: stderr ?? '',
                });
            } catch (e) { reject(e); }
        });
    });
}

async function _serviceEnabled() {
    const r = await _spawn(['systemctl', 'is-enabled', TAILSCALED_UNIT]);
    // systemctl is-enabled prints "enabled" / "disabled" / "static" / etc.
    const out = r.stdout.trim();
    return { available: r.code !== 4, enabled: out === 'enabled' || out === 'enabled-runtime' };
}

/* -------------------------------------------------------------------------- */
/*                         Shortcut capture row                               */
/* -------------------------------------------------------------------------- */

const ShortcutRow = GObject.registerClass(
class ShortcutRow extends Adw.ActionRow {
    _init({ title, subtitle, key, settings }) {
        super._init({ title, subtitle: subtitle || '', activatable: true });
        this._key = key;
        this._settings = settings;

        this._label = new Gtk.ShortcutLabel({
            disabled_text: _('Disabled'),
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(this._label);

        this._clearButton = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: _('Clear shortcut'),
            css_classes: ['flat'],
        });
        this._clearButton.connect('clicked', () => settings.set_strv(this._key, []));
        this.add_suffix(this._clearButton);

        this.connect('activated', () => this._capture());

        this._handlerId = settings.connect(`changed::${key}`, () => this._sync());
        this.connect('destroy', () => settings.disconnect(this._handlerId));
        this._sync();
    }

    _sync() {
        const accel = this._settings.get_strv(this._key)[0] || '';
        this._label.set_accelerator(accel);
        this._clearButton.sensitive = !!accel;
    }

    _capture() {
        const root = this.get_root();
        const dialog = new Adw.Window({
            modal: true,
            transient_for: root,
            title: _('Set shortcut'),
            default_width: 420,
            default_height: 180,
            resizable: false,
        });
        const toolbar = new Adw.ToolbarView();
        toolbar.add_top_bar(new Adw.HeaderBar({ show_title: false }));
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.CENTER,
            spacing: 12,
            margin_start: 24, margin_end: 24,
            margin_top: 24,   margin_bottom: 24,
        });
        content.append(new Gtk.Label({
            label: `<b>${_('Press a key combination')}</b>`,
            use_markup: true,
        }));
        content.append(new Gtk.Label({
            label: _('Escape to cancel · Backspace to clear'),
            css_classes: ['dim-label'],
        }));
        toolbar.set_content(content);
        dialog.set_content(toolbar);

        const controller = new Gtk.EventControllerKey();
        dialog.add_controller(controller);
        controller.connect('key-pressed', (_c, keyval, _kc, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask();
            if (keyval === Gdk.KEY_Escape && !mask) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if ((keyval === Gdk.KEY_BackSpace || keyval === Gdk.KEY_Delete) && !mask) {
                this._settings.set_strv(this._key, []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (Gtk.accelerator_valid(keyval, mask)) {
                const accel = Gtk.accelerator_name(keyval, mask);
                this._settings.set_strv(this._key, [accel]);
                dialog.close();
            }
            return Gdk.EVENT_STOP;
        });
        dialog.present();
    }
});

/* -------------------------------------------------------------------------- */
/*                           Service (boot) row                               */
/* -------------------------------------------------------------------------- */

// Taildrop preferences: accept toggle + inbox folder. The accept toggle is
// mirrored from gsettings (the quick menu writes it too). The inbox path
// is text-editable and has a folder picker button as a suffix.
function _makeTaildropGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _('Taildrop'),
        description: _('Send and receive files between Tailscale nodes.'),
    });

    const acceptRow = new Adw.SwitchRow({
        title: _('Accept incoming files'),
        subtitle: _('Runs the Tailscale receiver in the background while enabled.'),
    });
    settings.bind('taildrop-accept', acceptRow, 'active', Gio.SettingsBindFlags.DEFAULT);
    group.add(acceptRow);

    const inboxRow = new Adw.EntryRow({
        title: _('Inbox folder'),
        show_apply_button: false,
    });
    settings.bind('taildrop-inbox', inboxRow, 'text', Gio.SettingsBindFlags.DEFAULT);

    const browseBtn = new Gtk.Button({
        icon_name: 'document-open-symbolic',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
        tooltip_text: _('Browse'),
    });
    browseBtn.connect('clicked', () => {
        const dlg = new Gtk.FileDialog({
            title: _('Choose Taildrop inbox folder'),
            modal: true,
        });
        dlg.select_folder(group.get_root(), null, (d, res) => {
            try {
                const f = d.select_folder_finish(res);
                if (f) inboxRow.text = f.get_path();
            } catch (_) { /* cancelled */ }
        });
    });
    inboxRow.add_suffix(browseBtn);
    group.add(inboxRow);

    const hintRow = new Adw.ActionRow({
        title: _('Folder is created if it does not exist'),
        subtitle: _('Leave empty to use ~/Downloads/Taildrop.'),
    });
    hintRow.add_prefix(new Gtk.Image({ icon_name: 'dialog-information-symbolic' }));
    group.add(hintRow);

    return group;
}

// File manager integration: install/remove Nautilus scripts that hook
// "Send with Taildrop" and "Send with Taildrop as ZIP" into the right-click
// menu of selected files.
function _makeIntegrationsGroup(extensionDir) {
    const group = new Adw.PreferencesGroup({
        title: _('File manager integration'),
        description: _('Add right-click actions in Nautilus to send selected files via Taildrop.'),
    });

    const scriptsDir = GLib.build_filenamev([
        GLib.get_user_data_dir(), 'nautilus', 'scripts',
    ]);
    const sendName = 'Send with Taildrop';
    const zipName  = 'Send with Taildrop as ZIP';

    const isInstalled = () => {
        const p1 = Gio.File.new_for_path(GLib.build_filenamev([scriptsDir, sendName]));
        const p2 = Gio.File.new_for_path(GLib.build_filenamev([scriptsDir, zipName]));
        return p1.query_exists(null) && p2.query_exists(null);
    };

    const row = new Adw.ActionRow({
        title: _('Nautilus right-click scripts'),
    });
    const statusLabel = new Gtk.Label({
        valign: Gtk.Align.CENTER,
        css_classes: ['dim-label'],
    });
    row.add_suffix(statusLabel);

    const installBtn = new Gtk.Button({
        label: _('Install'),
        valign: Gtk.Align.CENTER,
        css_classes: ['suggested-action'],
    });
    const removeBtn = new Gtk.Button({
        label: _('Remove'),
        valign: Gtk.Align.CENTER,
        css_classes: ['destructive-action'],
    });
    row.add_suffix(installBtn);
    row.add_suffix(removeBtn);

    const refresh = () => {
        const ok = isInstalled();
        statusLabel.label = ok ? _('Installed') : _('Not installed');
        installBtn.visible = !ok;
        removeBtn.visible  = ok;
    };

    const toast = (title) => {
        group.get_root()?.add_toast?.(new Adw.Toast({ title, timeout: 4 }));
    };

    installBtn.connect('clicked', () => {
        try {
            Gio.File.new_for_path(scriptsDir).make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                toast(`Error: ${e.message}`); return;
            }
        }
        const srcDir = extensionDir.get_child('nautilus');
        for (const name of [sendName, zipName]) {
            const src = srcDir.get_child(name);
            const dst = Gio.File.new_for_path(GLib.build_filenamev([scriptsDir, name]));
            try {
                src.copy(dst, Gio.FileCopyFlags.OVERWRITE, null, null);
                const info = new Gio.FileInfo();
                info.set_attribute_uint32('unix::mode', 0o755);
                dst.set_attributes_from_info(info, Gio.FileQueryInfoFlags.NONE, null);
            } catch (e) {
                toast(`Error installing ${name}: ${e.message}`);
                return;
            }
        }
        refresh();
        toast(_('Installed. You may need to restart Nautilus.'));
    });

    removeBtn.connect('clicked', () => {
        for (const name of [sendName, zipName]) {
            const f = Gio.File.new_for_path(GLib.build_filenamev([scriptsDir, name]));
            try { f.delete(null); } catch (_) {}
        }
        refresh();
        toast(_('Removed.'));
    });

    refresh();
    group.add(row);
    return group;
}

// Adw.SwitchRow is `final` in libadwaita 1.4+, so we can't subclass it. Build
// one and wire the systemctl toggle externally instead.
function _makeServiceRow() {
    const row = new Adw.SwitchRow({
        title: _('Start Tailscale at boot'),
        subtitle: _('Enables tailscaled.service via systemctl (asks for password).'),
    });

    let guard = false;

    const refresh = async () => {
        const { available, enabled } = await _serviceEnabled();
        row.sensitive = available;
        guard = true;
        row.active = enabled;
        guard = false;
        if (!available)
            row.subtitle = _('tailscaled.service not found. Install Tailscale via your distribution.');
    };

    const toggle = async (enable) => {
        const argv = ['pkexec', 'systemctl',
            enable ? 'enable' : 'disable', '--now', TAILSCALED_UNIT];
        const r = await _spawn(argv);
        if (!r.ok) {
            guard = true;
            row.active = !enable;
            guard = false;
            const root = row.get_root();
            if (root && root.add_toast) {
                root.add_toast(new Adw.Toast({
                    title: _('Could not change service state'),
                    timeout: 4,
                }));
            }
        }
        refresh();
    };

    row.connect('notify::active', () => {
        if (guard) return;
        toggle(row.active);
    });

    refresh();
    return row;
}

/* -------------------------------------------------------------------------- */
/*                                  Page                                      */
/* -------------------------------------------------------------------------- */

function _fmt(template, ...args) {
    let i = 0;
    return template.replace(/%[sd]/g, () => String(args[i++] ?? ''));
}

export default class TailscaleGnomePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _('General'),
            iconName: 'preferences-system-symbolic',
        });
        window.add(page);

        /* ----------------------------- Display -------------------------- */
        const displayGroup = new Adw.PreferencesGroup({
            title: _('Display'),
        });
        page.add(displayGroup);

        const showRow = new Adw.SwitchRow({
            title: _('Show panel indicator'),
            subtitle: _('Small Tailscale icon next to Wi-Fi while connected.'),
        });
        settings.bind('show-indicator', showRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(showRow);

        /* ----------------------------- Taildrop ------------------------- */
        page.add(_makeTaildropGroup(settings));
        page.add(_makeIntegrationsGroup(this.dir));

        /* ---------------------------- Shortcuts ------------------------- */
        const shortcutsGroup = new Adw.PreferencesGroup({
            title: _('Shortcuts'),
            description: _('Click a row to capture a key combination. Backspace to clear.'),
        });
        page.add(shortcutsGroup);

        for (const def of [
            { key: 'shortcut-toggle-tailscale',  title: _('Connect / disconnect Tailscale') },
            { key: 'shortcut-toggle-exit-node',  title: _('Toggle automatic exit node') },
            { key: 'shortcut-show-menu',         title: _('Open the Tailscale menu') },
            { key: 'shortcut-copy-self-ip',      title: _("Copy this device's Tailscale IP") },
            { key: 'shortcut-open-admin-panel',  title: _('Open the Tailscale admin console') },
            { key: 'shortcut-send-file',         title: _('Send a file via Taildrop') },
        ]) {
            shortcutsGroup.add(new ShortcutRow({ ...def, settings }));
        }

        /* ---------------------------- Advanced -------------------------- */
        const advanced = new Adw.PreferencesGroup({
            title: _('Advanced'),
        });
        page.add(advanced);

        // Start at boot lives at the top of Advanced so the section stays
        // a single, low-frequency settings block.
        advanced.add(_makeServiceRow());

        const pollRow = new Adw.SpinRow({
            title: _('Poll interval'),
            subtitle: _('Seconds between status refreshes (2 to 60).'),
            adjustment: new Gtk.Adjustment({
                lower: 2, upper: 60, step_increment: 1, page_increment: 5,
            }),
        });
        settings.bind('poll-interval', pollRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        advanced.add(pollRow);

        const binaryRow = new Adw.EntryRow({ title: _('tailscale binary') });
        settings.bind('tailscale-binary', binaryRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        advanced.add(binaryRow);

    }
}
