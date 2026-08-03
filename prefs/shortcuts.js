// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// The Shortcuts page, and the capture row it is made of.

import Adw from "gi://Adw";
import Gdk from "gi://Gdk";
import GObject from "gi://GObject";
import Gtk from "gi://Gtk";

import { gettext as _ } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import { watchSetting } from "./common.js";

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

            watchSetting(this, settings, key, () => this._sync());
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
    // The two keys are still named for what they used to do: send a file,
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

export function makeShortcutsPage(settings) {
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
