// Preferences dialog (Adwaita). GNOME 46+.

import Adw from "gi://Adw";
import Gdk from "gi://Gdk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Gtk from "gi://Gtk";
import Pango from "gi://Pango";

import {
    ExtensionPreferences,
    gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import {
    fmt as _fmt,
    spawn as _spawn,
} from "./lib/util.js";
// Pure module, no Shell imports: importing it here is what keeps the mode
// nicks and the category-to-key map from drifting between the two processes.
import { CATEGORY_KEY, NotifyMode } from "./lib/notify-policy.js";

const TAILSCALED_UNIT = "tailscaled.service";

/* -------------------------------------------------------------------------- */
/*                            Subprocess helpers                              */
/* -------------------------------------------------------------------------- */

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
    } catch {
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
    // Grey these rows out when the tailnet forbids Taildrop: they would have
    // no effect, and the Availability group above says why.
    const syncSensitivity = () => {
        group.sensitive = settings.get_boolean("feature-taildrop-available");
    };
    const sensId = settings.connect(
        "changed::feature-taildrop-available",
        syncSensitivity,
    );
    group.connect("destroy", () => settings.disconnect(sensId));
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
        if (v !== settings.get_string("taildrop-inbox")) {
            settings.set_string("taildrop-inbox", v);
            // Confirm the change — commitInbox also fires on focus-out
            // with an unchanged value, so the toast is gated on an actual
            // write to keep it from nagging.
            group.get_root().add_toast(
                new Adw.Toast({
                    title: _fmt(_("Taildrop inbox set to %s"), v),
                    timeout: 3,
                }),
            );
        }
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
            } catch {
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
        group.get_root().add_toast(new Adw.Toast({ title, timeout: 4 }));
    };

    installBtn.connect("clicked", () => {
        try {
            Gio.File.new_for_path(scriptsDir).make_directory_with_parents(null);
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
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
            } catch {
                // Already gone: nothing to remove.
            }
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

/* -------------------------------------------------------------------------- */
/*                             Availability group                             */
/* -------------------------------------------------------------------------- */

// Taildrop and Funnel can be forbidden tailnet-wide by an administrator.
// That is a fact to report, not a setting: each row shows what the shell's
// last poll saw and points at the admin page when the answer is no. There
// is nothing to re-check by hand — the extension reads availability out of
// every `status --json` it already runs and writes these keys, so the rows
// follow along through the `changed::` each one watches.
const AVAILABILITY_DEFS = [
    {
        availabilityKey: "feature-taildrop-available",
        title: () => _("Taildrop"),
        adminUrl: "https://login.tailscale.com/admin/settings/general",
        docUrl: "https://tailscale.com/docs/features/taildrop",
        unavailableHint: () => _("Taildrop is disabled for this tailnet."),
        infoText: () =>
            _(
                "Taildrop requires the feature to be enabled for the tailnet and the source and destination devices to be owned by the same user. Devices owned by a tag or by different users are not eligible.",
            ),
    },
    {
        availabilityKey: "feature-funnels-available",
        title: () => _("Funnel"),
        adminUrl:
            "https://login.tailscale.com/admin/acls/visual/node-attributes",
        docUrl: "https://tailscale.com/docs/features/tailscale-funnel",
        unavailableHint: () => _("Funnel is not enabled for this tailnet."),
        infoText: () =>
            _(
                'Funnel requires HTTPS certificates to be enabled tailnet-wide and the "funnel" node attribute granted to the current user.',
            ),
    },
];

function _openUrl(url) {
    try {
        Gio.AppInfo.launch_default_for_uri(url, null);
    } catch {
        // Best-effort: no browser configured. The URL is also shown in
        // the row tooltip, so the user can still reach it.
    }
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

    const id = settings.connect(`changed::${def.key}`, () => {
        syncSubtitle();
        if (syncing) return;
        syncing = true;
        button.set_rgba(_parseColor(read(), fallback));
        syncing = false;
    });
    row.connect("destroy", () => settings.disconnect(id));

    button.set_rgba(_parseColor(read(), fallback));
    syncSubtitle();

    row.add_suffix(button);
    row.add_suffix(_resetButton(settings, def.key));
    return row;
}

// Per-row reset suffix: restores the GSettings key — or every key in the
// array — to its schema default. Uses `view-refresh-symbolic`; the
// availability check button uses `rotation-allowed-symbolic` to stay
// visually distinct from a reset.
function _resetButton(settings, key) {
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

// Build one availability row: an explanation, a status icon, a re-check
// button, and — only when the answer is no — a link to the admin page that
// can change it. No switch: the user cannot grant themselves an ACL, and a
// control that cannot honour a click is a lie.
function _makeAvailabilityRow(settings, def) {
    const row = new Adw.ActionRow({ title: def.title() });

    const infoBtn = new Gtk.Button({
        icon_name: "info-outline-symbolic",
        valign: Gtk.Align.CENTER,
        css_classes: ["flat", "circular"],
        tooltip_text: _fmt(
            _("%s\n\nClick to open: %s"),
            def.infoText(),
            def.docUrl,
        ),
    });
    infoBtn.connect("clicked", () => _openUrl(def.docUrl));
    row.add_prefix(infoBtn);

    // libadwaita's success/error classes follow the user's light or dark
    // theme; a hardcoded colour would not.
    const statusIcon = new Gtk.Image({ valign: Gtk.Align.CENTER });

    const adminBtn = new Gtk.Button({
        label: _("Open admin"),
        valign: Gtk.Align.CENTER,
        css_classes: ["suggested-action"],
    });
    adminBtn.connect("clicked", () => _openUrl(def.adminUrl));

    row.add_suffix(statusIcon);
    row.add_suffix(adminBtn);

    const sync = () => {
        const available = settings.get_boolean(def.availabilityKey);
        // object-select-symbolic, not emblem-ok-symbolic: the latter is gone
        // from current Adwaita, so the "available" tick silently rendered as
        // nothing.
        statusIcon.icon_name = available
            ? "object-select-symbolic"
            : "window-close-symbolic";
        statusIcon.css_classes = [available ? "success" : "error"];
        // An icon alone is not readable by a screen reader.
        statusIcon.tooltip_text = available
            ? _("Available on this tailnet")
            : _("Not available on this tailnet");
        row.subtitle = available ? "" : def.unavailableHint();
        adminBtn.visible = !available;
    };
    const id = settings.connect(`changed::${def.availabilityKey}`, sync);
    row.connect("destroy", () => settings.disconnect(id));
    sync();
    return row;
}

function _makeAvailabilityGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _("Availability"),
        description: _(
            "What this tailnet allows. Both depend on your tailnet's admin settings, not on anything you can change here. (Hover over the info icon for details)",
        ),
    });
    for (const def of AVAILABILITY_DEFS)
        group.add(_makeAvailabilityRow(settings, def));
    return group;
}

/* -------------------------------------------------------------------------- */
/*                             Notifications page                             */
/* -------------------------------------------------------------------------- */

// Every event the extension can report, in the order they appear in the
// page. Keys match CATEGORY_KEY in lib/notify-policy.js.
// Titles/subtitles are deferred behind a closure — same convention as
// AVAILABILITY_DEFS above — because this array is built at module-import time,
// before the sandboxed prefs loader has an extension context to resolve
// gettext against. Calling _() here directly throws "gettext can only be
// called from extensions"; def.title()/def.subtitle() are only invoked
// later, from inside _makeNotificationsPage().
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
    // string-to-string binding — no mapping functions, and an out-of-range
    // dconf value can never reach the widget.
    settings.bind(
        def.key,
        group,
        "active-name",
        Gio.SettingsBindFlags.DEFAULT,
    );
    row.add_suffix(group);
    row.add_suffix(_resetButton(settings, def.key));
    return row;
}

// Quick access at the top of the list: one control that drives all of them.
// It has no key of its own — it reads the categories back, and shows a mode
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

    const ids = keys.map((k) => settings.connect(`changed::${k}`, sync));
    row.connect("destroy", () => {
        for (const id of ids) settings.disconnect(id);
    });
    sync();

    row.add_suffix(group);
    // Resets the nine category keys only — not the whole page, and not the
    // pending-duration spinner above it.
    row.add_suffix(_resetButton(settings, keys));
    return row;
}

function _makeNotificationsPage(settings) {
    const page = new Adw.PreferencesPage({
        title: _("Notifications"),
        iconName: "preferences-system-notifications-symbolic",
    });

    /* ---------------------------- Presentation --------------------------- */
    const modeGroup = new Adw.PreferencesGroup({
        title: _("Presentation"),
        description: _(
            "Reports post as native GNOME notifications, stacking into a browsable history under a single Tailscale entry. How long a banner stays on screen is GNOME's own setting, not this extension's.",
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
    spinnerRow.add_suffix(_resetButton(settings, "min-pending-duration"));
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

/* -------------------------------------------------------------------------- */
/*                              Shortcuts page                                */
/* -------------------------------------------------------------------------- */

// Titles are thunks for the same reason NOTIFY_DEFS uses them: the module
// body runs before gettext is initialised.
const SHORTCUT_DEFS = [
    {
        key: "shortcut-toggle-tailscale",
        title: () => _("Connect / disconnect Tailscale"),
    },
    {
        key: "shortcut-toggle-exit-node",
        title: () => _("Toggle automatic exit node"),
    },
    {
        key: "shortcut-show-menu",
        title: () => _("Open the Tailscale menu"),
    },
    {
        key: "shortcut-open-admin-panel",
        title: () => _("Open the Tailscale admin console"),
    },
    // The two keys are still named for what they used to do — send a file,
    // add a funnel. Both now open their dialog instead, which is where
    // those actions live; the keys keep their names so a shortcut someone
    // has already bound survives the rename.
    {
        key: "shortcut-send-file",
        title: () => _("Open Taildrop"),
    },
    {
        key: "shortcut-add-funnel",
        title: () => _("Open Funnels"),
    },
];

function _makeShortcutsPage(settings) {
    const page = new Adw.PreferencesPage({
        title: _("Shortcuts"),
        iconName: "org.gnome.Settings-keyboard-symbolic",
    });

    const group = new Adw.PreferencesGroup({
        title: _("Keyboard shortcuts"),
        description: _(
            "Click a row to capture a key combination. Backspace to clear.",
        ),
    });
    page.add(group);

    for (const def of SHORTCUT_DEFS)
        group.add(
            new ShortcutRow({ key: def.key, title: def.title(), settings }),
        );

    return page;
}

/* -------------------------------------------------------------------------- */
/*                                 Help page                                  */
/* -------------------------------------------------------------------------- */

const UNKNOWN_VALUE = "—";

// One "label: value" row. The value is a selectable label rather than a
// subtitle so a single line can be picked out and pasted into a bug report
// without taking the rest of the page with it.
function _makeInfoRow(title) {
    const row = new Adw.ActionRow({ title });
    const value = new Gtk.Label({
        label: UNKNOWN_VALUE,
        valign: Gtk.Align.CENTER,
        selectable: true,
        css_classes: ["dim-label"],
        // hexpand claims the empty run between the title and the right
        // edge, which is where these values belong: "Fedora Linux 44
        // (Workstation Edition)" fits on one line there and was only
        // wrapping because a max-width-chars cap held it to a narrow
        // column. Wrapping stays on for the window narrowed by hand, and
        // WORD_CHAR is what lets it break inside an unbroken version
        // string rather than pushing the window wider.
        hexpand: true,
        wrap: true,
        wrap_mode: Pango.WrapMode.WORD_CHAR,
        xalign: 1,
    });
    row.add_suffix(value);
    return {
        row,
        set: (text) => (value.label = text || UNKNOWN_VALUE),
        get: () => value.label,
    };
}

// A row that opens a URL. The address goes in the tooltip because the row
// itself only carries a purpose ("Report a problem"), and someone should be
// able to see where a click will take them before taking it.
function _makeLinkRow(title, subtitle, url) {
    const row = new Adw.ActionRow({
        title,
        subtitle,
        activatable: true,
        tooltip_text: url,
    });
    // external-link-symbolic, not adw-external-link-symbolic: the latter is
    // libadwaita's own name for it and is not in the icon theme, so it would
    // have rendered as nothing at all.
    row.add_suffix(
        new Gtk.Image({
            icon_name: "external-link-symbolic",
            valign: Gtk.Align.CENTER,
            css_classes: ["dim-label"],
        }),
    );
    row.connect("activated", () => _openUrl(url));
    return row;
}

// `tailscale version --daemon` prints the CLI's own version first and the
// daemon's on a "Daemon:" line — but only when it can reach the daemon.
// Falling back to the first line (the CLI version) keeps the row useful on
// a machine where tailscaled is stopped, which is exactly the machine
// someone is most likely to be filing a bug from.
function _parseTailscaleVersion(stdout) {
    const lines = stdout.split("\n").map((l) => l.trim());
    const daemon = lines.find((l) => l.startsWith("Daemon:"));
    if (daemon) return { version: daemon.slice("Daemon:".length).trim() };

    const client = lines.find((l) => l.startsWith("Client:"));
    if (client)
        return {
            version: client.slice("Client:".length).trim(),
            clientOnly: true,
        };

    // Plain `tailscale version` leads with the bare number. The shape test
    // matters: when the command fails it prints prose on that first line,
    // and "failed to connect to local tailscaled" is not a version.
    const bare = lines.find((l) => /^\d+\.\d+/.test(l));
    if (bare) return { version: bare, clientOnly: true };
    return {};
}

function _osDescription() {
    const pretty = GLib.get_os_info("PRETTY_NAME");
    if (pretty) return pretty;
    const name = GLib.get_os_info("NAME");
    const version = GLib.get_os_info("VERSION");
    if (name) return version ? `${name} ${version}` : name;
    return "";
}

function _copyToClipboard(widget, text) {
    const display = widget.get_display() ?? Gdk.Display.get_default();
    if (!display) return false;
    const value = new GObject.Value();
    value.init(GObject.TYPE_STRING);
    value.set_string(text);
    return display
        .get_clipboard()
        .set_content(Gdk.ContentProvider.new_for_value(value));
}

function _makeHelpPage(settings, metadata) {
    const page = new Adw.PreferencesPage({
        title: _("Help"),
        iconName: "help-about-symbolic",
    });

    const repoUrl = metadata.url || "https://github.com/Disk-MTH/Tailscale-Gnome";

    /* --------------------------- Availability ---------------------------- */
    // First on the page, ahead of the versions: it answers "why can I not
    // see this feature", which is the question that brings someone here.
    // No probe on open — the group shows the last poll's answer and follows
    // the key from there. The shell refreshes it every few seconds whether
    // this window is up or not.
    page.add(_makeAvailabilityGroup(settings));

    /* ------------------------------ Versions ----------------------------- */
    const about = new Adw.PreferencesGroup({
        title: _("About"),
        description: _(
            "What is running on this machine. Include it when reporting a problem.",
        ),
    });
    page.add(about);

    const extensionRow = _makeInfoRow(_("Extension"));
    const tailscaleRow = _makeInfoRow(_("Tailscale daemon"));
    const osRow = _makeInfoRow(_("Operating system"));
    const shellRow = _makeInfoRow(_("GNOME Shell"));
    for (const r of [extensionRow, tailscaleRow, osRow, shellRow])
        about.add(r.row);

    // version-name is the human one ("0.2.1"); `version` is the integer
    // EGO increments on every upload and means nothing to a user.
    extensionRow.set(
        metadata["version-name"] ||
            (metadata.version != null ? String(metadata.version) : ""),
    );
    osRow.set(_osDescription());

    // Both of these shell out, so the page builds with placeholders and
    // fills in when the answers arrive. A failure leaves the row on its
    // placeholder, which already says "we could not tell" — it goes to the
    // log rather than at the user, who did not ask for it and cannot act
    // on it.
    const bin = settings.get_string("tailscale-binary") || "tailscale";
    _spawn([bin, "version", "--daemon"])
        .then((r) => {
            const { version, clientOnly } = _parseTailscaleVersion(r.stdout);
            tailscaleRow.set(version);
            if (version && clientOnly)
                tailscaleRow.row.subtitle = _(
                    "Daemon unreachable — this is the CLI version.",
                );
        })
        .catch((e) => console.warn(`tailscale-gnome: ${e}`));

    _spawn(["gnome-shell", "--version"])
        .then((r) => shellRow.set(r.stdout.replace(/^GNOME Shell\s*/, "").trim()))
        .catch((e) => console.warn(`tailscale-gnome: ${e}`));

    // Copying the four rows in one go is the whole point of collecting
    // them: a bug report wants all of it, and re-typing a version string is
    // how a report ends up with the wrong one.
    const copyBtn = new Gtk.Button({
        icon_name: "edit-copy-symbolic",
        valign: Gtk.Align.CENTER,
        css_classes: ["flat"],
        tooltip_text: _("Copy this information to the clipboard"),
    });
    copyBtn.connect("clicked", () => {
        const text = [extensionRow, tailscaleRow, osRow, shellRow]
            .map((r) => `${r.row.title}: ${r.get()}`)
            .join("\n");
        if (!_copyToClipboard(copyBtn, text)) return;
        // The prefs window is an Adw.PreferencesDialog on current GNOME and
        // an Adw.PreferencesWindow before it; both take a toast, but only
        // once the page is in one, which a header-suffix click guarantees.
        const root = copyBtn.get_root();
        root?.add_toast?.(
            new Adw.Toast({ title: _("Copied to clipboard"), timeout: 3 }),
        );
    });
    about.set_header_suffix(copyBtn);

    /* -------------------------------- Links ------------------------------ */
    const links = new Adw.PreferencesGroup({ title: _("Project") });
    page.add(links);

    links.add(
        _makeLinkRow(
            _("Source code"),
            _("Browse the extension's repository on GitHub."),
            repoUrl,
        ),
    );
    links.add(
        _makeLinkRow(
            _("Report a problem"),
            _("Open an issue on GitHub. Attach the information above."),
            `${repoUrl}/issues`,
        ),
    );

    return page;
}

/* -------------------------------------------------------------------------- */
/*                                  Page                                      */
/* -------------------------------------------------------------------------- */

export default class TailscaleGnomePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // The shell opens this at a size that leaves the four page titles
        // fighting for the header, and "Notifications" loses — it comes up
        // elided to "Notifi…". Wide enough for all four spelled out, and
        // for the longest of them in French and German too. Guarded rather
        // than called outright: the host is an Adw.PreferencesWindow today,
        // but the same entry point is documented against Adw.Dialog, which
        // sizes through content-width instead.
        if (typeof window.set_default_size === "function")
            window.set_default_size(820, 700);

        const page = new Adw.PreferencesPage({
            title: _("General"),
            iconName: "preferences-system-symbolic",
        });
        window.add(page);
        window.add(_makeNotificationsPage(settings));
        window.add(_makeShortcutsPage(settings));
        window.add(_makeHelpPage(settings, this.metadata));

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
        showRow.add_suffix(_resetButton(settings, "show-indicator"));
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
            _resetButton(settings, "show-exit-node-active-indicator"),
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
            _resetButton(settings, "show-exit-node-indicator"),
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
        page.add(_makeTaildropGroup(settings, this.dir));

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
        pollRow.add_suffix(_resetButton(settings, "poll-interval"));
        advanced.add(pollRow);

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
            const bin = settings.get_string("tailscale-binary") || "tailscale";
            try {
                await _spawn([
                    bin,
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
                await _spawn([bin, "funnel", "reset"]);
            } catch {}

            // The two availability keys were reset along with everything
            // else, and nothing here puts them back: the shell rewrites
            // them from its next poll, a second or two out. Probing them
            // here would only race that.

            window.add_toast(
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
