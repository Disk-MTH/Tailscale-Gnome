# SPDX-FileCopyrightText: 2026 Disk_MTH
# SPDX-License-Identifier: GPL-2.0-or-later

"""Nautilus extension: hand a selection to the Tailscale GNOME extension.

Loaded by nautilus-python out of the file manager's own extensions
directory, where the shell extension symlinks this file while "Nautilus
integration" is on. It replaces the pair of shell scripts that used to be
copied into ~/.local/share/nautilus/scripts: those only ever reached the
Scripts submenu, three clicks deep, and each one re-implemented the D-Bus
call in bash.

The menu item carries no logic of its own. It calls the SendFiles method
the shell extension exports and lets the in-shell picker (the same dialog
the keyboard shortcut opens) own the whole interaction.

The Nautilus API version is asked for in turn rather than named outright:
it moved with the file manager (4.0 up to GNOME 47, 4.1 after), so pinning
one would break the other, while naming none at all makes PyGObject warn
into the journal on every start. Whichever the host runtime already loaded
is the one that answers.
"""

import gettext
import os

import gi

gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
gi.require_version("GObject", "2.0")

for _api in ("4.1", "4.0"):
    try:
        gi.require_version("Nautilus", _api)
        break
    except ValueError:
        continue

from gi.repository import Gio, GLib, GObject, Nautilus

BUS_NAME = "org.gnome.Shell"
OBJECT_PATH = "/org/gnome/Shell/Extensions/TailscaleGnome"
INTERFACE = "org.gnome.Shell.Extensions.TailscaleGnome"

# The shell extension's own catalogue, so the context menu is worded by the
# same strings as the dialog it opens. __file__ here is the symlink sitting in
# the file manager's extensions directory; resolving it leads back to the
# extension directory, where locale/ sits one level up from this file.
#
# fallback=True is what keeps a missing catalogue from being fatal: an
# exception raised at import time would cost the whole menu entry, and English
# is a better answer than none.
_LOCALE_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.realpath(__file__))), "locale"
)

_ = gettext.translation(
    "tailscale-gnome",
    localedir=_LOCALE_DIR if os.path.isdir(_LOCALE_DIR) else None,
    fallback=True,
).gettext


class TailscaleTaildropExtension(GObject.GObject, Nautilus.MenuProvider):
    """A "Taildrop" entry in the file manager's context menu."""

    def _activate(self, _menu, files):
        # Only local files can be handed over: the extension shells out to
        # `tailscale file cp`, which takes paths, and a gvfs mount (sftp://,
        # mtp://, trash://) has no path to give. get_path() answers None
        # there, which is what drops those entries.
        paths = []

        for f in files:
            path = Gio.File.new_for_uri(f.get_uri()).get_path()
            if path:
                paths.append(path)

        if not paths:
            return

        try:
            bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        except GLib.Error as e:
            print(f"tailscale-gnome: no session bus: {e.message}")
            return

        # Asynchronous: a synchronous call would block the file manager's UI
        # for as long as the shell takes to answer. NO_AUTO_START because the
        # name belongs to GNOME Shell, which is either up or the session is
        # already over.
        bus.call(
            BUS_NAME,
            OBJECT_PATH,
            INTERFACE,
            "SendFiles",
            GLib.Variant("(as)", (paths,)),
            None,
            Gio.DBusCallFlags.NO_AUTO_START,
            -1,
            None,
            self._on_call_done,
            None,
        )

    def _on_call_done(self, bus, result, _data):
        # Nothing to report on success: the picker appearing is the answer.
        # A failure means the extension is disabled or the shell restarted
        # since this file was loaded, and the journal is where that belongs:
        # a notification here would fire from the file manager for a fault
        # of the shell's.
        try:
            bus.call_finish(result)
        except GLib.Error as e:
            print(f"tailscale-gnome: SendFiles failed: {e.message}")

    def get_file_items(self, *args):
        # The signature moved with the API: Nautilus 4.x passes (files,),
        # 3.x passed (window, files). Taking the last argument covers both.
        files = args[-1]

        if not files:
            return []

        item = Nautilus.MenuItem(
            name="TailscaleGnome::Taildrop",
            label=_("Send with Taildrop"),
            tip=_("Send the selection to a Tailscale device"),
        )
        item.connect("activate", self._activate, files)

        return [item]
