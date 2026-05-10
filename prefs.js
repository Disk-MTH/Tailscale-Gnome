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

async function _operatorUser(binary) {
    const r = await _spawn([binary || 'tailscale', 'debug', 'prefs']);
    if (!r.ok) return { available: false, user: null };
    try {
        const json = JSON.parse(r.stdout);
        return { available: true, user: json?.OperatorUser || null };
    } catch {
        return { available: false, user: null };
    }
}

async function _fetchFunnels(binary) {
    const r = await _spawn([binary, 'funnel', 'status', '--json']);
    if (!r.ok) return [];
    try {
        const j = JSON.parse(r.stdout);
        const flagMap = j?.Funnel ?? j?.AllowFunnel ?? {};
        const webMap  = j?.Web ?? {};
        const out = [];
        for (const key of Object.keys(flagMap)) {
            if (!flagMap[key]) continue;
            const m = key.match(/^(.+):(\d+)$/);
            if (!m) continue;
            const httpsPort = parseInt(m[2], 10);
            const slash = webMap[key]?.Handlers?.['/'];
            const target = slash?.Proxy || slash?.Text || '';
            out.push({ host: m[1], httpsPort, target });
        }
        return out.sort((a, b) => a.httpsPort - b.httpsPort);
    } catch {
        return [];
    }
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
/*                          Operator status row                               */
/* -------------------------------------------------------------------------- */

const OperatorRow = GObject.registerClass(
class OperatorRow extends Adw.ActionRow {
    _init({ binary }) {
        super._init({
            title: _('Tailscale operator'),
            subtitle: _('Checking…'),
        });
        this._binary = binary;

        this._statusIcon = new Gtk.Image({
            icon_name: 'content-loading-symbolic',
            valign: Gtk.Align.CENTER,
        });
        this.add_prefix(this._statusIcon);

        this._copyButton = new Gtk.Button({
            label: _('Copy fix command'),
            valign: Gtk.Align.CENTER,
            visible: false,
            css_classes: ['suggested-action'],
        });
        this._copyButton.connect('clicked', () => this._copyCommand());
        this.add_suffix(this._copyButton);

        this.refresh();
    }

    setBinary(bin) { this._binary = bin; }

    async refresh() {
        const { available, user } = await _operatorUser(this._binary);
        if (!available) {
            this._statusIcon.icon_name = 'dialog-warning-symbolic';
            this.subtitle = _('tailscaled is not reachable. Is the daemon running?');
            this._copyButton.visible = false;
            return;
        }
        if (user) {
            // object-select-symbolic renders as a clean checkmark in Adwaita,
            // unlike emblem-ok-symbolic which is a small badge-style tick.
            this._statusIcon.icon_name = 'object-select-symbolic';
            this._statusIcon.add_css_class?.('success');
            this.subtitle = _fmt(_('Set to "%s". The extension can control Tailscale.'), user);
            this._copyButton.visible = false;
        } else {
            this._statusIcon.remove_css_class?.('success');
            this._statusIcon.icon_name = 'dialog-warning-symbolic';
            this.subtitle = _('Not set. Without it, every up/down/set call is silently denied.');
            this._copyButton.visible = true;
        }
    }

    _copyCommand() {
        const cmd = `sudo tailscale set --operator=${GLib.get_user_name()}`;
        const display = this.get_display();
        if (display) {
            const clipboard = display.get_clipboard();
            clipboard.set(cmd);
        }
        const root = this.get_root();
        if (root && root.add_toast) {
            root.add_toast(new Adw.Toast({
                title: _('Command copied to clipboard'),
                timeout: 3,
            }));
        }
    }
});

/* -------------------------------------------------------------------------- */
/*                           Service (boot) row                               */
/* -------------------------------------------------------------------------- */

// Manage Tailscale Funnels (public HTTPS exposure of a local service). Builds
// a PreferencesGroup whose top row adds new funnels and whose subsequent rows
// list active ones with a remove button each. Refreshes itself after every
// add/remove.
function _makeFunnelGroup(binary) {
    const group = new Adw.PreferencesGroup({
        title: _('Funnel'),
        description: _('Expose a local service on the public internet via Tailscale. Anyone with the URL can reach the exposed port.'),
    });

    const dynamicRows = [];

    const portSpin = new Gtk.SpinButton({
        valign: Gtk.Align.CENTER,
        adjustment: new Gtk.Adjustment({
            lower: 1, upper: 65535, step_increment: 1, page_increment: 100,
            value: 3000,
        }),
    });

    const addRow = new Adw.ActionRow({
        title: _('Add a funnel'),
        subtitle: _('Local port to expose on https://<device>.<tailnet>.ts.net'),
    });
    addRow.add_suffix(portSpin);
    const addButton = new Gtk.Button({
        label: _('Add'),
        valign: Gtk.Align.CENTER,
        css_classes: ['suggested-action'],
    });
    addRow.add_suffix(addButton);
    group.add(addRow);

    const toast = (title) => {
        group.get_root()?.add_toast?.(new Adw.Toast({ title, timeout: 4 }));
    };

    const refresh = async () => {
        for (const r of dynamicRows) group.remove(r);
        dynamicRows.length = 0;
        const funnels = await _fetchFunnels(binary);
        for (const f of funnels) {
            const url = `https://${f.host}${f.httpsPort === 443 ? '' : `:${f.httpsPort}`}`;
            const row = new Adw.ActionRow({
                title: url,
                subtitle: f.target ? _fmt(_('proxies %s'), f.target) : '',
            });
            const removeBtn = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                tooltip_text: _('Remove this funnel'),
            });
            removeBtn.connect('clicked', async () => {
                removeBtn.sensitive = false;
                const r = await _spawn([binary, 'funnel', `--https=${f.httpsPort}`, 'off']);
                if (!r.ok) toast(_('Could not remove funnel'));
                refresh();
            });
            row.add_suffix(removeBtn);
            group.add(row);
            dynamicRows.push(row);
        }
    };

    addButton.connect('clicked', async () => {
        const port = portSpin.get_value_as_int();
        addButton.sensitive = false;
        const r = await _spawn([binary, 'funnel', '--bg', '--https=443', String(port)]);
        addButton.sensitive = true;
        if (!r.ok) {
            const msg = (r.stderr || r.stdout).split('\n')[0]?.trim() || _('Could not add funnel');
            toast(msg);
            return;
        }
        refresh();
    });

    refresh();
    return { group, refresh };
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
        const binary = settings.get_string('tailscale-binary') || 'tailscale';

        const page = new Adw.PreferencesPage({
            title: _('General'),
            iconName: 'preferences-system-symbolic',
        });
        window.add(page);

        /* ---------------------------- Operator -------------------------- */
        const operatorGroup = new Adw.PreferencesGroup({
            title: _('Operator status'),
            description: _('Tailscale on Linux only accepts state changes from the user marked as operator.'),
        });
        const operatorRow = new OperatorRow({ binary });
        operatorGroup.add(operatorRow);
        page.add(operatorGroup);

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

        const subtitleRow = new Adw.SwitchRow({
            title: _('Show subtitle on the toggle'),
            subtitle: _('Display the connected account or status under the title.'),
        });
        settings.bind('show-subtitle', subtitleRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        displayGroup.add(subtitleRow);

        /* ----------------------------- Funnel --------------------------- */
        const { group: funnelGroup } = _makeFunnelGroup(binary);
        page.add(funnelGroup);

        /* ---------------------------- Shortcuts ------------------------- */
        const shortcutsGroup = new Adw.PreferencesGroup({
            title: _('Shortcuts'),
            description: _('Click a row to capture a key combination. Backspace to clear.'),
        });
        page.add(shortcutsGroup);

        for (const def of [
            { key: 'shortcut-toggle-tailscale', title: _('Connect / disconnect Tailscale') },
            { key: 'shortcut-toggle-exit-node', title: _('Toggle automatic exit node') },
            { key: 'shortcut-show-menu',        title: _('Open the Tailscale menu') },
            { key: 'shortcut-copy-self-ip',     title: _("Copy this device's Tailscale IP") },
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

        // Re-check operator status if the user changes the binary path.
        const id = settings.connect('changed::tailscale-binary', () => {
            operatorRow.setBinary(settings.get_string('tailscale-binary') || 'tailscale');
            operatorRow.refresh();
        });
        window.connect('close-request', () => settings.disconnect(id));
    }
}
