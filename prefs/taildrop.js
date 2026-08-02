// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// The Taildrop group on the General page: where inbound files land, and
// whether the file manager offers "Send with Taildrop". The accept toggle
// itself lives in the Quick Settings panel, not here.

import Adw from "gi://Adw";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk";

import { gettext as _ } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import { fmt as _fmt, spawn as _spawn } from "../lib/util.js";
// The preferences ask whether the integration is possible, the shell acts
// on the answer, and both read it out of one place.
import { hasPythonLoader } from "../lib/nautilus.js";
import { watchSetting } from "./common.js";

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

// Taildrop preferences: inbox folder + Nautilus integration.
// The accept toggle lives in the Quick Settings panel.
export function makeTaildropGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: _("Taildrop"),
        description: _("Send and receive files between Tailscale nodes."),
    });
    // Grey these rows out when the tailnet forbids Taildrop: they would have
    // no effect, and the Availability group above says why.
    const syncSensitivity = () => {
        group.sensitive = settings.get_boolean("feature-taildrop-available");
    };
    watchSetting(
        group,
        settings,
        "feature-taildrop-available",
        syncSensitivity,
    );
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
    watchSetting(inboxRow, settings, "taildrop-inbox", () => {
        const v = settings.get_string("taildrop-inbox") || defaultInbox;
        if (inboxRow.text !== v) inboxRow.text = v;
        updateValidity();
    });

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

    // File manager integration. One switch, no Install / Remove pair: the
    // extension owns the link now, made on enable and dropped on disable, so
    // a button that installs by hand would only be a second source of truth
    // for the same file.
    const nautilusRow = new Adw.SwitchRow({
        title: _("Nautilus integration"),
        subtitle: _(
            'Add "Send with Taildrop" to the file manager\'s right-click menu.',
        ),
    });
    group.add(nautilusRow);

    // Not bound to the setting: flipping it asks first, and a bound switch
    // has already written by the time there is anything to ask about. The
    // guard is the same one the service row uses — it marks the writes we
    // make ourselves, so setting the switch back after a Cancel does not read
    // as a second toggle.
    let guard = false;
    const setActive = (v) => {
        guard = true;
        nautilusRow.active = v;
        guard = false;
    };
    setActive(settings.get_boolean("nautilus-integration"));

    // Follows the key rather than owning it: a `dconf write`, a settings
    // reset, or a second preferences window all reach the switch this way.
    watchSetting(nautilusRow, settings, "nautilus-integration", () =>
        setActive(settings.get_boolean("nautilus-integration")),
    );

    // No loader, no integration: the file we link is a python file-manager
    // extension, and nothing reads it without nautilus-python. Greying the
    // switch out is the honest answer — leaving it live would let the user
    // turn on a feature that cannot appear, with nothing to explain why.
    if (!hasPythonLoader()) {
        nautilusRow.sensitive = false;

        const missingRow = new Adw.ActionRow({
            title: _("nautilus-python is not installed"),
            subtitle: _(
                "The file manager needs it to load extensions. Install it " +
                    "with your package manager, then reopen this window.",
            ),
            css_classes: ["warning"],
        });
        missingRow.add_prefix(
            new Gtk.Image({
                icon_name: "dialog-warning-symbolic",
                valign: Gtk.Align.CENTER,
                css_classes: ["warning"],
            }),
        );
        group.add(missingRow);

        return group;
    }

    nautilusRow.connect("notify::active", () => {
        if (guard) return;

        const wanted = nautilusRow.active;
        const dialog = new Adw.AlertDialog({
            heading: _("Quit the file manager?"),
            // Said plainly because it is the whole reason for the prompt:
            // Nautilus reads its extensions once, at startup, so the change
            // cannot reach a window that is already open.
            body: _(
                "Nautilus loads its extensions when it starts, so it has to " +
                    "be closed for this to take effect. Any open Nautilus " +
                    "window will be closed, and the next one you open picks " +
                    "up the change.",
            ),
        });
        dialog.add_response("cancel", _("Cancel"));
        dialog.add_response("quit", _("Quit Nautilus"));
        dialog.set_response_appearance(
            "quit",
            Adw.ResponseAppearance.DESTRUCTIVE,
        );
        dialog.set_default_response("quit");
        dialog.set_close_response("cancel");

        dialog.choose(nautilusRow.get_root(), null, (dlg, res) => {
            if (dlg.choose_finish(res) !== "quit") {
                setActive(!wanted);
                return;
            }
            // Written before the quit, not after: the shell extension makes
            // or drops the link off this key, and nothing relaunches the file
            // manager on its own, so by the time a window is opened again the
            // link is already whichever way it should be.
            settings.set_boolean("nautilus-integration", wanted);
            _quitFileManagers();
        });
    });

    return group;
}

// `nautilus -q` asks the running instance to quit rather than signalling it,
// so a copy in progress ends on its own terms. It exits quietly when nothing
// is running, which is why there is nothing to check first.
//
// A Flatpak Nautilus is a different process in a different namespace and does
// not hear `-q` from the host, hence the second call. There is no equivalent
// for Snap: its confinement offers no "ask the app to quit", and killing it
// outright is not ours to do.
async function _quitFileManagers() {
    await _spawn(["nautilus", "-q"]);

    const flatpakApp = GLib.build_filenamev([
        GLib.get_home_dir(),
        ".var",
        "app",
        "org.gnome.Nautilus",
    ]);
    if (Gio.File.new_for_path(flatpakApp).query_exists(null))
        await _spawn(["flatpak", "kill", "org.gnome.Nautilus"]);
}
