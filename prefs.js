// Preferences dialog (Adwaita). GNOME 46+.

import Adw from "gi://Adw";
import Gdk from "gi://Gdk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Gtk from "gi://Gtk";

import {
    ExtensionPreferences,
    gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

const TAILSCALED_UNIT = "tailscaled.service";

/* -------------------------------------------------------------------------- */
/*                            Subprocess helpers                              */
/* -------------------------------------------------------------------------- */

function _spawn(argv) {
    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE |
                    Gio.SubprocessFlags.STDERR_PIPE,
            );
        } catch (e) {
            reject(e);
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                resolve({
                    ok: p.get_successful(),
                    code: p.get_exit_status(),
                    stdout: stdout ?? "",
                    stderr: stderr ?? "",
                });
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function _serviceEnabled() {
    const r = await _spawn(["systemctl", "is-enabled", TAILSCALED_UNIT]);
    // systemctl is-enabled prints "enabled" / "disabled" / "static" / etc.
    const out = r.stdout.trim();
    return {
        available: r.code !== 4,
        enabled: out === "enabled" || out === "enabled-runtime",
    };
}

// True when the user can create/write at the given path without elevation:
// walk up to the first existing ancestor and check the can-write attribute.
// Empty/relative paths and system roots (/etc, /var, …) all land here via
// the kernel's own permission bits — no allow-list to maintain.
function _isPathSafe(p) {
    if (!p || !p.trim().startsWith("/")) return false;
    let f = Gio.File.new_for_path(p);
    while (f && !f.query_exists(null)) f = f.get_parent();
    if (!f) return false;
    try {
        const info = f.query_info(
            "access::can-write",
            Gio.FileQueryInfoFlags.NONE,
            null,
        );
        return info.get_attribute_boolean("access::can-write");
    } catch (_) {
        return false;
    }
}

/* -------------------------------------------------------------------------- */
/*                         Shortcut capture row                               */
/* -------------------------------------------------------------------------- */

const ShortcutRow = GObject.registerClass(
    class ShortcutRow extends Adw.ActionRow {
        _init({ title, subtitle, key, settings }) {
            super._init({ title, subtitle: subtitle || "", activatable: true });
            this._key = key;
            this._settings = settings;

            this._label = new Gtk.ShortcutLabel({
                disabled_text: _("Disabled"),
                valign: Gtk.Align.CENTER,
            });
            this.add_suffix(this._label);

            this._clearButton = new Gtk.Button({
                icon_name: "edit-clear-symbolic",
                valign: Gtk.Align.CENTER,
                tooltip_text: _("Clear shortcut"),
                css_classes: ["flat"],
            });
            this._clearButton.connect("clicked", () =>
                settings.set_strv(this._key, []),
            );
            this.add_suffix(this._clearButton);

            this.connect("activated", () => this._capture());

            this._handlerId = settings.connect(`changed::${key}`, () =>
                this._sync(),
            );
            this.connect("destroy", () => settings.disconnect(this._handlerId));
            this._sync();
        }

        _sync() {
            const accel = this._settings.get_strv(this._key)[0] || "";
            this._label.set_accelerator(accel);
            this._clearButton.sensitive = !!accel;
        }

        _capture() {
            const root = this.get_root();
            const dialog = new Adw.Window({
                modal: true,
                transient_for: root,
                title: _("Set shortcut"),
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
                margin_start: 24,
                margin_end: 24,
                margin_top: 24,
                margin_bottom: 24,
            });
            content.append(
                new Gtk.Label({
                    label: `<b>${_("Press a key combination")}</b>`,
                    use_markup: true,
                }),
            );
            content.append(
                new Gtk.Label({
                    label: _("Escape to cancel · Backspace to clear"),
                    css_classes: ["dim-label"],
                }),
            );
            toolbar.set_content(content);
            dialog.set_content(toolbar);

            const controller = new Gtk.EventControllerKey();
            dialog.add_controller(controller);
            controller.connect("key-pressed", (_c, keyval, _kc, state) => {
                const mask = state & Gtk.accelerator_get_default_mod_mask();
                if (keyval === Gdk.KEY_Escape && !mask) {
                    dialog.close();
                    return Gdk.EVENT_STOP;
                }
                if (
                    (keyval === Gdk.KEY_BackSpace ||
                        keyval === Gdk.KEY_Delete) &&
                    !mask
                ) {
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
    },
);

/* -------------------------------------------------------------------------- */
/*                           Service (boot) row                               */
/* -------------------------------------------------------------------------- */

// Taildrop preferences: inbox folder + Nautilus integration.
// The accept toggle lives in the Quick Settings panel.
function _makeTaildropGroup(settings, extensionDir) {
    const group = new Adw.PreferencesGroup({
        title: _("Taildrop"),
        description: _("Send and receive files between Tailscale nodes."),
    });
    // Mirror the feature switch: when Taildrop is disabled in Features
    // (either user-toggled or admin-blocked), these rows are greyed so
    // it's clear they have no effect.
    const syncSensitivity = () => {
        group.sensitive =
            settings.get_boolean("feature-taildrop") &&
            settings.get_boolean("feature-taildrop-available");
    };
    const sensId = settings.connect(
        "changed::feature-taildrop",
        syncSensitivity,
    );
    const sensId2 = settings.connect(
        "changed::feature-taildrop-available",
        syncSensitivity,
    );
    group.connect("destroy", () => {
        settings.disconnect(sensId);
        settings.disconnect(sensId2);
    });
    syncSensitivity();

    // Default inbox: must match TailscaleClient._resolveInbox in lib/tailscale.js.
    const defaultInbox = GLib.build_filenamev([
        GLib.get_home_dir(),
        "Downloads",
        "Taildrop",
    ]);
    // Migrate "empty means default" to an explicit prefilled value so the
    // input is never blank. The receiver treats both equivalently.
    if (!settings.get_string("taildrop-inbox"))
        settings.set_string("taildrop-inbox", defaultInbox);

    // Expand ~ and $HOME into an absolute path, leaving relative paths
    // alone so the user can spot and correct them on commit.
    const expandHome = (p) => {
        if (!p) return p;
        if (p === "~" || p.startsWith("~/"))
            return GLib.build_filenamev([GLib.get_home_dir(), p.slice(2)]);
        if (p.startsWith("$HOME"))
            return GLib.build_filenamev([
                GLib.get_home_dir(),
                p.slice(5).replace(/^\//, ""),
            ]);
        return p;
    };

    const inboxRow = new Adw.EntryRow({
        title: _("Inbox folder (created if it does not exist)"),
        show_apply_button: true,
    });
    // Initialise from the stored value but do NOT live-bind to settings;
    // every keystroke would otherwise restart the receiver and pre-create
    // partial folders ("T", "Ta", "Tai", ...) on disk. The setting is
    // committed below, only on apply (Enter / check button) or focus-out.
    inboxRow.text = settings.get_string("taildrop-inbox") || defaultInbox;

    // Warning glyph that surfaces when the typed path would need elevation.
    // Outline-style symbolic icon tinted with the Adwaita "warning" accent
    // (yellow/orange), matching the visual language of the rest of the app.
    const warningIcon = new Gtk.Image({
        icon_name: "dialog-warning-symbolic",
        valign: Gtk.Align.CENTER,
        tooltip_text: _(
            "Path is empty or not writable without admin privileges.",
        ),
        visible: false,
        css_classes: ["warning"],
    });
    inboxRow.add_suffix(warningIcon);

    // Canonicalise text (expand ~, force absolute under $HOME) without
    // touching the row so a transient invalid text doesn't leak back into
    // the input. Returns the path that would be persisted.
    const normalisePath = (text) => {
        let v = (text ?? "").trim();
        if (v === "") return defaultInbox;
        v = expandHome(v);
        if (!v.startsWith("/"))
            v = GLib.build_filenamev([GLib.get_home_dir(), v]);
        return v;
    };

    const updateValidity = () => {
        const v = normalisePath(inboxRow.text);
        const text = inboxRow.text.trim();
        const valid = text !== "" && _isPathSafe(v);
        // show_apply_button doubles as our "commit affordance is allowed"
        // signal. Hiding it when invalid stops both the check-button click
        // and the Enter key from emitting `apply` on an unwritable path.
        inboxRow.show_apply_button = valid;
        warningIcon.visible = !valid;
    };

    const commitInbox = () => {
        const text = inboxRow.text.trim();
        const v = normalisePath(inboxRow.text);
        // Refuse to persist a path the user can't write to — the receiver
        // would just crash on first file. Revert to the last committed
        // value so the row keeps reflecting reality.
        if (text === "" || !_isPathSafe(v)) {
            const committed =
                settings.get_string("taildrop-inbox") || defaultInbox;
            if (inboxRow.text !== committed) inboxRow.text = committed;
            updateValidity();
            return;
        }
        if (v !== inboxRow.text) inboxRow.text = v;
        if (v !== settings.get_string("taildrop-inbox"))
            settings.set_string("taildrop-inbox", v);
        updateValidity();
    };
    inboxRow.connect("apply", commitInbox);
    inboxRow.connect("notify::text", updateValidity);

    const focusCtrl = new Gtk.EventControllerFocus();
    inboxRow.add_controller(focusCtrl);
    focusCtrl.connect("leave", commitInbox);

    // Keep the row in sync when the setting is changed externally
    // (e.g. the reset button below, or another prefs window).
    const inboxId = settings.connect("changed::taildrop-inbox", () => {
        const v = settings.get_string("taildrop-inbox") || defaultInbox;
        if (inboxRow.text !== v) inboxRow.text = v;
        updateValidity();
    });
    inboxRow.connect("destroy", () => settings.disconnect(inboxId));

    updateValidity();

    const browseBtn = new Gtk.Button({
        icon_name: "document-open-symbolic",
        valign: Gtk.Align.CENTER,
        css_classes: ["flat"],
        tooltip_text: _("Browse"),
    });
    browseBtn.connect("clicked", () => {
        const dlg = new Gtk.FileDialog({
            title: _("Choose Taildrop inbox folder"),
            modal: true,
        });
        dlg.select_folder(group.get_root(), null, (d, res) => {
            try {
                const f = d.select_folder_finish(res);
                if (f) {
                    inboxRow.text = f.get_path();
                    commitInbox();
                }
            } catch (_) {
                /* cancelled */
            }
        });
    });

    const resetBtn = new Gtk.Button({
        icon_name: "view-refresh-symbolic",
        valign: Gtk.Align.CENTER,
        css_classes: ["flat"],
        tooltip_text: _("Reset to default"),
    });
    resetBtn.connect("clicked", () => {
        inboxRow.text = defaultInbox;
        commitInbox();
    });

    inboxRow.add_suffix(browseBtn);
    inboxRow.add_suffix(resetBtn);
    group.add(inboxRow);

    // Nautilus right-click integration
    const scriptsDir = GLib.build_filenamev([
        GLib.get_user_data_dir(),
        "nautilus",
        "scripts",
    ]);
    const sendName = "Send with Taildrop";
    const zipName = "Send with Taildrop as ZIP";

    const isInstalled = () => {
        const p1 = Gio.File.new_for_path(
            GLib.build_filenamev([scriptsDir, sendName]),
        );
        const p2 = Gio.File.new_for_path(
            GLib.build_filenamev([scriptsDir, zipName]),
        );
        return p1.query_exists(null) && p2.query_exists(null);
    };

    const nautilusRow = new Adw.ActionRow({
        title: _("Nautilus right-click scripts"),
        subtitle: _('Add "Send with Taildrop" to the Nautilus context menu.'),
    });
    const statusLabel = new Gtk.Label({
        valign: Gtk.Align.CENTER,
        css_classes: ["dim-label"],
    });
    nautilusRow.add_suffix(statusLabel);

    const installBtn = new Gtk.Button({
        label: _("Install"),
        valign: Gtk.Align.CENTER,
        css_classes: ["suggested-action"],
    });
    const removeBtn = new Gtk.Button({
        label: _("Remove"),
        valign: Gtk.Align.CENTER,
        css_classes: ["destructive-action"],
    });
    nautilusRow.add_suffix(installBtn);
    nautilusRow.add_suffix(removeBtn);

    const refreshNautilus = () => {
        const ok = isInstalled();
        statusLabel.label = ok ? _("Installed") : _("Not installed");
        installBtn.visible = !ok;
        removeBtn.visible = ok;
    };

    const toast = (title) => {
        group.get_root()?.add_toast?.(new Adw.Toast({ title, timeout: 4 }));
    };

    installBtn.connect("clicked", () => {
        try {
            Gio.File.new_for_path(scriptsDir).make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
                toast(`Error: ${e.message}`);
                return;
            }
        }
        const srcDir = extensionDir.get_child("nautilus");
        for (const name of [sendName, zipName]) {
            const src = srcDir.get_child(name);
            const dst = Gio.File.new_for_path(
                GLib.build_filenamev([scriptsDir, name]),
            );
            try {
                src.copy(dst, Gio.FileCopyFlags.OVERWRITE, null, null);
                const info = new Gio.FileInfo();
                info.set_attribute_uint32("unix::mode", 0o755);
                dst.set_attributes_from_info(
                    info,
                    Gio.FileQueryInfoFlags.NONE,
                    null,
                );
            } catch (e) {
                toast(`Error installing ${name}: ${e.message}`);
                return;
            }
        }
        refreshNautilus();
        toast(_("Installed. You may need to restart Nautilus."));
    });

    removeBtn.connect("clicked", () => {
        for (const name of [sendName, zipName]) {
            const f = Gio.File.new_for_path(
                GLib.build_filenamev([scriptsDir, name]),
            );
            try {
                f.delete(null);
            } catch (_) {}
        }
        refreshNautilus();
        toast(_("Removed."));
    });

    refreshNautilus();
    group.add(nautilusRow);

    return group;
}

// Adw.SwitchRow is `final` in libadwaita 1.4+, so we can't subclass it. Build
// one and wire the systemctl toggle externally instead.
function _makeServiceRow() {
    const row = new Adw.SwitchRow({
        title: _("Start Tailscale at boot"),
        subtitle: _(
            "Enables tailscaled.service via systemctl (asks for password).",
        ),
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
            const root = row.get_root();
            if (root && root.add_toast) {
                root.add_toast(
                    new Adw.Toast({
                        title: _("Could not change service state"),
                        timeout: 4,
                    }),
                );
            }
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

/* -------------------------------------------------------------------------- */
/*                              Features group                                */
/* -------------------------------------------------------------------------- */

// Each entry can mark itself optional + give an availability cache key.
// When the cache says the tailnet doesn't allow the feature, the toggle is
// greyed out and a "Open admin" button + hint subtitle appear.
const FEATURE_DEFS = [
    { key: "feature-exit-nodes", title: () => _("Exit nodes") },
    { key: "feature-dns", title: () => _("Magic DNS") },
    { key: "feature-routes", title: () => _("Subnet routes") },
    { key: "feature-shields-up", title: () => _("Shields up") },
    { key: "feature-ssh-server", title: () => _("Tailscale SSH server") },
    {
        key: "feature-taildrop",
        title: () => _("Taildrop"),
        availabilityKey: "feature-taildrop-available",
        adminUrl: "https://login.tailscale.com/admin/settings/general",
        docUrl: "https://tailscale.com/docs/features/taildrop",
        unavailableHint: () => _("Taildrop is disabled for this tailnet."),
        infoText: () =>
            _(
                "Taildrop requires the feature to be enabled for the tailnet and the source and destination devices to be owned by the same user. Devices owned by a tag or by different users are not eligible.",
            ),
        checker: _checkTaildrop,
    },
    {
        key: "feature-funnels",
        title: () => _("Funnel"),
        availabilityKey: "feature-funnels-available",
        adminUrl:
            "https://login.tailscale.com/admin/acls/visual/node-attributes",
        docUrl: "https://tailscale.com/docs/features/tailscale-funnel",
        unavailableHint: () => _("Funnel is not enabled for this tailnet."),
        infoText: () =>
            _(
                'Funnel requires HTTPS certificates to be enabled tailnet-wide and the "funnel" node attribute granted to the current user.',
            ),
        checker: _checkFunnel,
    },
];

// Probe Taildrop availability via the CLI. Mirrors fileTargets() in
// lib/tailscale.js: the "filesharing disabled" string only appears on
// stderr when an admin turned the feature off tailnet-wide, so we infer
// availability from the absence of that specific failure mode (success
// or "no peers" both mean "allowed").
async function _checkTaildrop(bin) {
    const r = await _spawn([bin, "file", "cp", "--targets"]);
    const combined = `${r.stderr || ""}\n${r.stdout || ""}`;
    if (
        !r.ok &&
        /taildrop|file sharing|filesharing/i.test(combined) &&
        /disabled|not enabled|not allowed|forbidden|no access|does not have/i.test(
            combined,
        )
    )
        return false;
    return true;
}

// Probe Funnel availability by reading Self.CapMap from `status --json`.
// Matches _buildSnapshot()'s passive check so the manual button agrees
// with whatever the daemon would have reported before.
async function _checkFunnel(bin) {
    const r = await _spawn([bin, "status", "--json"]);
    if (!r.ok) return false;
    try {
        const j = JSON.parse(r.stdout);
        const capMap = j?.Self?.CapMap || {};
        return Object.prototype.hasOwnProperty.call(capMap, "funnel");
    } catch (_) {
        return false;
    }
}

function _openUrl(url) {
    try {
        Gio.AppInfo.launch_default_for_uri(url, null);
    } catch (_) {}
}

// Per-row reset suffix: restores the GSettings key to its schema default.
// Uses the same `view-refresh-symbolic` as the Quick Settings refresh
// glyph; the per-feature availability check uses `emblem-synchronizing-
// symbolic` to stay visually distinct from a reset.
function _resetButton(settings, key) {
    const btn = new Gtk.Button({
        icon_name: "view-refresh-symbolic",
        valign: Gtk.Align.CENTER,
        css_classes: ["flat"],
        tooltip_text: _("Reset to default"),
    });
    btn.connect("clicked", () => settings.reset(key));
    return btn;
}

// Build a single Features row. Rows with an availabilityKey use a manual
// ActionRow + Gtk.Switch so we can:
//   - render the switch visually OFF when the daemon reports the feature
//     as unavailable (Adw.SwitchRow ties active to the bound setting and
//     stays ON when greyed, which read as confusing),
//   - keep the "Open admin" button clickable while the switch is greyed
//     (row.sensitive=false would propagate to all children, including the
//     button — so we only flip the switch's sensitivity).
function _makeFeatureRow(settings, def, window) {
    if (!def.availabilityKey) {
        const row = new Adw.SwitchRow({ title: def.title() });
        settings.bind(def.key, row, "active", Gio.SettingsBindFlags.DEFAULT);
        row.add_suffix(_resetButton(settings, def.key));
        return row;
    }

    const row = new Adw.ActionRow({ title: def.title() });

    if (def.infoText) {
        const infoBtn = new Gtk.Button({
            icon_name: "info-outline-symbolic",
            valign: Gtk.Align.CENTER,
            css_classes: ["flat", "circular"],
            tooltip_text: def.docUrl
                ? _fmt(_("%s\n\nClick to open: %s"), def.infoText(), def.docUrl)
                : def.infoText(),
        });
        if (def.docUrl) infoBtn.connect("clicked", () => _openUrl(def.docUrl));
        row.add_prefix(infoBtn);
    }

    const switchWidget = new Gtk.Switch({
        valign: Gtk.Align.CENTER,
    });

    const adminBtn = new Gtk.Button({
        label: _("Open admin"),
        valign: Gtk.Align.CENTER,
        css_classes: ["suggested-action"],
    });
    adminBtn.connect("clicked", () => _openUrl(def.adminUrl));

    const checkBtn = new Gtk.Button({
        icon_name: "rotation-allowed-symbolic",
        valign: Gtk.Align.CENTER,
        css_classes: ["flat"],
        tooltip_text: _("Check availability"),
    });
    checkBtn.connect("clicked", async () => {
        if (!def.checker) return;
        checkBtn.sensitive = false;
        const bin = settings.get_string("tailscale-binary") || "tailscale";
        let available;
        try {
            available = await def.checker(bin);
        } catch (_) {
            available = false;
        }
        settings.set_boolean(def.availabilityKey, available);
        checkBtn.sensitive = true;
        if (window?.add_toast) {
            const title = def.title();
            window.add_toast(
                new Adw.Toast({
                    title: available
                        ? _fmt(_("%s is available"), title)
                        : _fmt(_("%s is not available on this tailnet"), title),
                    timeout: 3,
                }),
            );
        }
    });

    const resetBtn = _resetButton(settings, def.key);

    row.set_activatable_widget(switchWidget);
    row.add_suffix(switchWidget);
    row.add_suffix(checkBtn);
    row.add_suffix(adminBtn);
    row.add_suffix(resetBtn);

    let guard = false;
    const sync = () => {
        guard = true;
        const available = settings.get_boolean(def.availabilityKey);
        const saved = settings.get_boolean(def.key);
        switchWidget.sensitive = available;
        switchWidget.active = available && saved;
        row.subtitle = available ? "" : def.unavailableHint();
        adminBtn.visible = !available;
        // Reset makes no sense when admin has disabled the feature — the
        // switch is forced off regardless, so the stored pref is irrelevant.
        resetBtn.visible = available;
        guard = false;
    };
    const ids = [
        settings.connect(`changed::${def.availabilityKey}`, sync),
        settings.connect(`changed::${def.key}`, sync),
    ];
    switchWidget.connect("notify::active", () => {
        if (guard) return;
        if (!settings.get_boolean(def.availabilityKey)) return;
        settings.set_boolean(def.key, switchWidget.active);
    });
    row.connect("destroy", () => ids.forEach((id) => settings.disconnect(id)));
    sync();
    return row;
}

function _makeFeaturesGroup(settings, window) {
    const group = new Adw.PreferencesGroup({
        title: _("Features"),
        description: _(
            "Enable or disable specific Tailscale features. Disabled features are hidden from the Quick Settings menu.",
        ),
    });
    for (const def of FEATURE_DEFS)
        group.add(_makeFeatureRow(settings, def, window));
    return group;
}

/* -------------------------------------------------------------------------- */
/*                                  Page                                      */
/* -------------------------------------------------------------------------- */

function _fmt(template, ...args) {
    let i = 0;
    return template.replace(/%[sd]/g, () => String(args[i++] ?? ""));
}

export default class TailscaleGnomePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: _("General"),
            iconName: "preferences-system-symbolic",
        });
        window.add(page);

        /* ----------------------------- Features ------------------------- */
        page.add(_makeFeaturesGroup(settings, window));

        /* ----------------------------- Taildrop ------------------------- */
        page.add(_makeTaildropGroup(settings, this.dir));

        /* ---------------------------- Shortcuts ------------------------- */
        const shortcutsGroup = new Adw.PreferencesGroup({
            title: _("Shortcuts"),
            description: _(
                "Click a row to capture a key combination. Backspace to clear.",
            ),
        });
        page.add(shortcutsGroup);

        for (const def of [
            {
                key: "shortcut-toggle-tailscale",
                title: _("Connect / disconnect Tailscale"),
            },
            {
                key: "shortcut-toggle-exit-node",
                title: _("Toggle automatic exit node"),
            },
            { key: "shortcut-show-menu", title: _("Open the Tailscale menu") },
            {
                key: "shortcut-open-admin-panel",
                title: _("Open the Tailscale admin console"),
            },
            { key: "shortcut-send-file", title: _("Send a file via Taildrop") },
        ]) {
            shortcutsGroup.add(new ShortcutRow({ ...def, settings }));
        }

        /* ---------------------------- Advanced -------------------------- */
        const advanced = new Adw.PreferencesGroup({
            title: _("Advanced"),
        });
        page.add(advanced);

        // The systemd unit toggle isn't a GSettings key, so no reset
        // suffix; the system manages its own state.
        advanced.add(_makeServiceRow());

        const showRow = new Adw.SwitchRow({
            title: _("Show panel indicator"),
            subtitle: _("Small Tailscale icon next to Wi-Fi while connected."),
        });
        settings.bind(
            "show-indicator",
            showRow,
            "active",
            Gio.SettingsBindFlags.DEFAULT,
        );
        showRow.add_suffix(_resetButton(settings, "show-indicator"));
        advanced.add(showRow);

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
        pollRow.add_suffix(_resetButton(settings, "poll-interval"));
        advanced.add(pollRow);

        const toastDurRow = new Adw.SpinRow({
            title: _("Toast duration"),
            subtitle: _("Seconds the result toast stays on screen (1 to 10)."),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 10,
                step_increment: 1,
                page_increment: 1,
            }),
        });
        settings.bind(
            "toast-duration",
            toastDurRow,
            "value",
            Gio.SettingsBindFlags.DEFAULT,
        );
        toastDurRow.add_suffix(_resetButton(settings, "toast-duration"));
        advanced.add(toastDurRow);

        const spinnerRow = new Adw.SpinRow({
            title: _("Minimum spinner duration"),
            subtitle: _(
                "Milliseconds the spinner stays visible before showing the result (0 to 3000). Prevents flicker on instant actions.",
            ),
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 3000,
                step_increment: 100,
                page_increment: 500,
            }),
        });
        settings.bind(
            "toast-min-spinner",
            spinnerRow,
            "value",
            Gio.SettingsBindFlags.DEFAULT,
        );
        spinnerRow.add_suffix(_resetButton(settings, "toast-min-spinner"));
        advanced.add(spinnerRow);

        const binaryRow = new Adw.EntryRow({ title: _("tailscale binary") });
        settings.bind(
            "tailscale-binary",
            binaryRow,
            "text",
            Gio.SettingsBindFlags.DEFAULT,
        );
        binaryRow.add_suffix(_resetButton(settings, "tailscale-binary"));
        advanced.add(binaryRow);

        /* ----------------------------- Reset all ------------------------ */
        // Global "reset everything" lives in its own group so it gets a
        // visual break from the dense list of settings above.
        const resetGroup = new Adw.PreferencesGroup();
        const resetAllRow = new Adw.ActionRow({
            title: _("Reset all settings"),
            subtitle: _("Restore every setting on this page to its default."),
        });
        const resetAllBtn = new Gtk.Button({
            label: _("Reset all"),
            valign: Gtk.Align.CENTER,
            css_classes: ["destructive-action"],
        });
        resetAllBtn.connect("clicked", async () => {
            // Reset all GSettings keys to their schema defaults.
            for (const k of settings.list_keys())
                settings.reset(k);

            // Also apply the corresponding defaults to the Tailscale daemon
            // so the Quick Settings menu reflects the reset state:
            //   Magic DNS off, accept routes off, shields up off,
            //   SSH server off, exit node cleared, any active funnels
            //   torn down.
            const bin = settings.get_string("tailscale-binary") || "tailscale";
            try {
                await _spawn([bin, "set",
                    "--accept-dns=false",
                    "--accept-routes=false",
                    "--shields-up=false",
                    "--ssh=false",
                    "--exit-node=",
                ]);
            } catch (_) {
                // Non-fatal: GSettings were reset regardless.
            }
            // `funnel reset` is its own subcommand; ignore failures (most
            // likely "no funnels to reset", which is exactly what we want).
            try { await _spawn([bin, "funnel", "reset"]); } catch (_) {}

            window.add_toast?.(
                new Adw.Toast({
                    title: _("All settings reset to defaults"),
                    timeout: 3,
                }),
            );
        });
        resetAllRow.add_suffix(resetAllBtn);
        resetGroup.add(resetAllRow);
        page.add(resetGroup);
    }
}
