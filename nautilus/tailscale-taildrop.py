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
import weakref

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

# Only ever used to ask which window is in front, and optional at that: if a
# future file manager is built on something else, the version negotiation
# fails here and the selection guard below simply stops guarding.
try:
    gi.require_version("Gtk", "4.0")
    from gi.repository import Gtk
except (ImportError, ValueError):
    Gtk = None

BUS_NAME = "org.gnome.Shell"
OBJECT_PATH = "/org/gnome/Shell/Extensions/TailscaleGnome"
INTERFACE = "org.gnome.Shell.Extensions.TailscaleGnome"

# The same conversation the other way round. The context menu hands the
# selection to the shell; the shell's Taildrop shortcut has to ask for it,
# because a keypress arrives with nothing attached. Answering here rather
# than sending every selection change over means the paths never leave this
# process until someone asks, and that browsing files costs no traffic at
# all. Read by lib/nautilus-selection.js, which owns the shell half.
SELECTION_NAME = "fr.diskmth.TailscaleGnome.Nautilus"
SELECTION_PATH = "/fr/diskmth/TailscaleGnome/Nautilus"
SELECTION_IFACE = "fr.diskmth.TailscaleGnome.Nautilus"

SELECTION_XML = """
<node>
  <interface name="fr.diskmth.TailscaleGnome.Nautilus">
    <method name="GetSelection">
      <arg type="as" name="paths" direction="out"/>
    </method>
  </interface>
</node>
"""


def _local_paths(files):
    """Local filesystem paths for a selection, dropping anything without one.

    The extension shells out to `tailscale file cp`, which takes paths, and a
    gvfs mount (sftp://, mtp://, trash://) has none to give. get_path()
    answers None there, which is what drops those entries.
    """
    paths = []

    for f in files:
        path = Gio.File.new_for_uri(f.get_uri()).get_path()
        if path:
            paths.append(path)

    return paths


def _active_window():
    """The window in front, or None when that cannot be told.

    Asked of Gtk rather than of the application. The obvious call is
    Gtk.Application.get_active_window(), but NautilusApplication does not
    carry it through introspection, and reaching for it there raised
    AttributeError inside get_file_items() and cost the whole context menu:
    an entry that failed to build is an entry the file manager does not
    show. The toplevel list answers the same question without depending on
    what the application happens to be.

    Returns None on any failure, which every caller reads as "cannot tell"
    rather than as an answer.
    """
    if Gtk is None:
        return None
    try:
        toplevels = Gtk.Window.get_toplevels()
        for i in range(toplevels.get_n_items()):
            window = toplevels.get_item(i)
            if window.is_active():
                return window
    except Exception:
        return None
    return None

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

    def __init__(self):
        super().__init__()
        # Last selection seen, and the window that was in front when it was
        # seen. See _get_selection() for what the window is for.
        self._selection = []
        self._selection_window = None
        self._node = Gio.DBusNodeInfo.new_for_xml(SELECTION_XML)
        # NONE, not REPLACE: a second Nautilus would mean a second copy of
        # this script, and the one that got there first is as good an answer
        # as any. Losing the name simply leaves the shortcut with nothing to
        # ask, which it already handles.
        self._owner_id = Gio.bus_own_name(
            Gio.BusType.SESSION,
            SELECTION_NAME,
            Gio.BusNameOwnerFlags.NONE,
            self._on_bus_acquired,
            None,
            None,
        )

    def _on_bus_acquired(self, connection, _name):
        try:
            connection.register_object(
                SELECTION_PATH,
                self._node.interfaces[0],
                self._on_method_call,
                None,
                None,
            )
        except GLib.Error as e:
            print(f"tailscale-gnome: cannot export the selection: {e.message}")

    def _on_method_call(
        self, _conn, _sender, _path, _iface, method, _params, invocation
    ):
        if method != "GetSelection":
            invocation.return_error_literal(
                Gio.dbus_error_quark(),
                Gio.DBusError.UNKNOWN_METHOD,
                f"no such method: {method}",
            )
            return

        # Same reasoning as get_file_items(): an exception escaping here
        # would leave the shell waiting on an invocation nobody answers.
        # Answering "nothing selected" costs the user one file chooser.
        try:
            paths = self._get_selection()
        except Exception as e:
            print(f"tailscale-gnome: cannot read the selection: {e}")
            paths = []

        invocation.return_value(GLib.Variant("(as)", (paths,)))

    def _get_selection(self):
        """The cached selection, if it still belongs to what the user sees.

        One instance of this class serves every window in the process, and
        Nautilus 4.x passes get_file_items() the files alone, never the
        window they came from. So with two windows open the cache holds
        whichever one last changed its selection, which need not be the one
        in front.

        Comparing the window that was active at capture against the one
        active now is what keeps that from sending the wrong files: a
        mismatch answers nothing and the shell falls back to its ordinary
        picker. When neither can be identified there is nothing to disagree
        about, and the cache is served: that is the single-window case.
        """
        active = _active_window()
        captured = self._selection_window() if self._selection_window else None

        if active is not None and captured is not None and active is not captured:
            return []

        return list(self._selection)

    def _remember(self, files):
        self._selection = _local_paths(files)
        # Weak, so a closed window is collected on time rather than held
        # open by a cache. A dead reference reads as "cannot identify",
        # which _get_selection() already treats as inconclusive.
        window = _active_window()
        try:
            self._selection_window = weakref.ref(window) if window else None
        except TypeError:
            self._selection_window = None

    def _activate(self, _menu, files):
        paths = _local_paths(files)

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

        # Called on every selection change, not only on right-click: the
        # file manager rebuilds its context menus from
        # nautilus_files_view_send_selection_change(), about 100 ms behind
        # the change. That is what makes this the place to keep the
        # selection current for the shortcut, and it is also why an empty
        # selection is recorded rather than ignored, so deselecting really
        # empties the answer.
        #
        # Guarded, and not as a formality. This bookkeeping serves the
        # keyboard shortcut, a convenience; the return value below is the
        # context menu entry, the feature. An exception raised here takes
        # the entry with it and Nautilus shows nothing at all, which is
        # exactly what an AttributeError in here once did. Nothing this
        # method does for the shortcut is worth that, so it is contained.
        try:
            self._remember(files)
        except Exception as e:
            print(f"tailscale-gnome: selection not recorded: {e}")

        if not files:
            return []

        item = Nautilus.MenuItem(
            name="TailscaleGnome::Taildrop",
            label=_("Send with Taildrop"),
            tip=_("Send the selection to a Tailscale device"),
        )
        item.connect("activate", self._activate, files)

        return [item]
