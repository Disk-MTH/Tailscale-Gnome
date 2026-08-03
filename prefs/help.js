// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// The Help page: what this tailnet allows, what is running on this
// machine, and where to report a problem.

import Adw from "gi://Adw";
import Gdk from "gi://Gdk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Gtk from "gi://Gtk";
import Pango from "gi://Pango";

import { gettext as _ } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

import { fmt as _fmt, spawn as _spawn } from "../lib/util.js";
import { makeBackendGroup, watchSetting } from "./common.js";

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
                "Taildrop requires the feature to be enabled for the tailnet " +
                    "and the source and destination devices to be owned by " +
                    "the same user. Devices owned by a tag or by different " +
                    "users are not eligible.",
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
    watchSetting(row, settings, def.availabilityKey, sync);
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

export function makeHelpPage(settings, metadata) {
    const page = new Adw.PreferencesPage({
        title: _("Help"),
        iconName: "help-about-symbolic",
    });

    const repoUrl = metadata.url || "https://github.com/Disk-MTH/Tailscale-Gnome";

    /* --------------------------- Availability ---------------------------- */
    // The backend group comes first, ahead of Availability, which reads a
    // tailnet's ACL out of the last poll: with no backend there was no
    // poll, and whatever the ACL says is a leftover from the last machine
    // state that could answer. It is also the only group left on the only
    // page left while the backend is down, which is what makes this page
    // worth keeping open in that state at all.
    page.add(makeBackendGroup(settings));

    // Then Availability, ahead of the versions: it answers "why can I not
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

    // version-name is the human one ("1.0.0"); `version` is the integer
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
    _spawn(["tailscale", "version", "--daemon"])
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
        // A header-suffix click can only land once the page is in the
        // preferences window, so the root is there and takes a toast.
        copyBtn
            .get_root()
            .add_toast(
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
