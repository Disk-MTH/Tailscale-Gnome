# Tailscale GNOME Shell extension: build / install / package
# Targets GNOME Shell 46 → 50.

UUID        := tailscale-gnome@diskmth.fr
NAME        := Tailscale
URL         := https://github.com/Disk-MTH/Tailscale-Gnome
USER_EXTDIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA      := schemas/org.gnome.shell.extensions.tailscale-gnome.gschema.xml
COMPILED    := schemas/gschemas.compiled
ZIPNAME     := $(UUID).shell-extension.zip
# Throwaway config for the nested shell. See the `nested` recipe for why.
NESTED_CFG  := /tmp/tailscale-gnome-nested-config

# Translations. The domain must match metadata.json's "gettext-domain";
# GNOME Shell 45+ binds it to <extension>/locale/ on its own.
DOMAIN      := tailscale-gnome
POT         := po/$(DOMAIN).pot
# One level of subdirectory too: make's wildcard has no `**`, and the menu
# rows and dialogs (lib/menu/) and the preference pages (prefs/) carry
# translatable strings of their own.
SOURCES     := extension.js prefs.js $(wildcard lib/*.js) $(wildcard lib/*/*.js) \
               $(wildcard prefs/*.js)
# The file-manager extension is python, and shares the catalogue so its
# context-menu entry is worded by the same strings as the dialog it opens.
PY_SOURCES  := $(wildcard nautilus/*.py)
PO_FILES    := $(wildcard po/*.po)
MO_FILES    := $(patsubst po/%.po,locale/%/LC_MESSAGES/$(DOMAIN).mo,$(PO_FILES))

.PHONY: all schemas install uninstall enable disable reset pack clean test test-syntax help \
        translations pot update-po nested nested-config

all: schemas translations

help:
	@printf "Targets:\n"
	@printf "  schemas      Compile the GSettings schema\n"
	@printf "  translations Compile po/*.po into locale/*/LC_MESSAGES\n"
	@printf "  pot          Re-extract translatable strings into %s\n" "$(POT)"
	@printf "  update-po    Merge new strings from the .pot into every .po\n"
	@printf "  install      Install to %s\n" "$(USER_EXTDIR)"
	@printf "  uninstall    Remove the installed extension\n"
	@printf "  enable       Enable the extension via gnome-extensions\n"
	@printf "  disable      Disable the extension via gnome-extensions\n"
	@printf "  reset        Reset all preferences (dconf)\n"
	@printf "  nested       Install, then run a nested shell with it enabled\n"
	@printf "  pack         Build a publishable .shell-extension.zip\n"
	@printf "  test-syntax  Quick syntax check on every JS file via gjs\n"
	@printf "  test         Run the unit tests for the pure modules via gjs\n"
	@printf "  clean        Remove generated files\n"

$(COMPILED): $(SCHEMA)
	glib-compile-schemas schemas/

schemas: $(COMPILED)

# Extract every _("…") from the JS sources. Regenerated on demand rather
# than as a build step: the .pot is a translator-facing artifact, and
# rewriting it on every build would churn its POT-Creation-Date.
pot:
	@mkdir -p po
	@xgettext --from-code=UTF-8 --language=JavaScript \
	    --keyword=_ --keyword=C_:1c,2 --keyword=ngettext:1,2 \
	    --package-name="$(NAME)" --copyright-holder="" \
	    --msgid-bugs-address="$(URL)/issues" \
	    --output="$(POT)" $(SOURCES)
	@xgettext --from-code=UTF-8 --language=Python \
	    --keyword=_ --keyword=C_:1c,2 --keyword=ngettext:1,2 \
	    --join-existing --output="$(POT)" $(PY_SOURCES)
	@printf "Extracted %s\n" "$(POT)"

# Pull newly extracted strings into the existing catalogs, keeping the
# translations already made. Run after `make pot`.
update-po: $(POT)
	@for po in $(PO_FILES); do \
	    printf "merging %-12s " "$$po"; \
	    msgmerge --quiet --update --backup=none "$$po" "$(POT)" && printf "OK\n"; \
	done

locale/%/LC_MESSAGES/$(DOMAIN).mo: po/%.po
	@mkdir -p "$(dir $@)"
	@msgfmt --check --output-file="$@" "$<"

translations: $(MO_FILES)

# Directories are replaced rather than merged. `cp -r` into an existing
# install only ever adds: a file dropped from the source tree (the 0.2.x
# nautilus scripts, say) would live on in the installed copy, and __pycache__
# from a local python run would ride along with it.
install: schemas translations
	@mkdir -p "$(USER_EXTDIR)"
	@cp -r metadata.json extension.js prefs.js stylesheet.css "$(USER_EXTDIR)/"
	@rm -rf "$(USER_EXTDIR)/lib" "$(USER_EXTDIR)/prefs" "$(USER_EXTDIR)/icons" \
	        "$(USER_EXTDIR)/schemas" "$(USER_EXTDIR)/nautilus" \
	        "$(USER_EXTDIR)/locale"
	@cp -r lib prefs icons schemas nautilus "$(USER_EXTDIR)/"
	@rm -rf "$(USER_EXTDIR)/nautilus/__pycache__"
	@cp -r locale "$(USER_EXTDIR)/" 2>/dev/null || true
	@cp -r LICENSE README.md CHANGELOG.md "$(USER_EXTDIR)/" 2>/dev/null || true
	@printf "Installed to %s\n" "$(USER_EXTDIR)"
	@printf "Restart GNOME Shell (Xorg: Alt+F2 r ; Wayland: log out / log in)\n"
	@printf "or try it without touching this session:  make nested\n"

uninstall:
	@rm -rf "$(USER_EXTDIR)"
	@printf "Removed %s\n" "$(USER_EXTDIR)"

enable:
	@gnome-extensions enable "$(UUID)"

disable:
	@gnome-extensions disable "$(UUID)"

reset:
	@dconf reset -f /org/gnome/shell/extensions/tailscale-gnome/

# A throwaway shell in a window of its own, so a change can be seen without
# restarting the session. It is also the only way to see one at all: GNOME
# Shell caches extension modules, so `make install` does not reach a shell
# that is already running. Only a fresh one, nested or after a log out,
# loads changed code.
#
# The nested shell gets a *copy* of the real dconf, and the override goes in
# front of dbus-run-session rather than inside it. Both matter.
#
# The copy, because a nested session shares the settings database with the
# live one: anything it writes, an extension of its own being enabled or a
# preference it touches, lands in the config of the desktop you are sitting
# in. Copying gets the same list of enabled extensions, so the nested menu
# looks like the real one, without writing back to it.
#
# In front, because dconf does not run in this process. It is a D-Bus
# service the bus activates, and an activated service inherits the *bus's*
# environment, not its caller's. Exporting XDG_CONFIG_HOME inside the
# session leaves dconf-service pointed at the real database anyway, which is
# exactly the trap this comment exists to stop anyone falling into twice.
#
# What does and does not work in there, for this extension specifically:
#
#   - The menu, the peers, the exit nodes and the tailnet rows all show real
#     data. The CLI talks to tailscaled over a unix socket, which has
#     nothing to do with the session bus.
#   - Elevated commands prompt in the nested window: gnome-shell brings its
#     own polkit agent along.
#   - The file manager half does NOT work. dbus-run-session builds a fresh
#     session bus, and the Nautilus you can see is on the real one, so the
#     context-menu entry and the shortcut's selection pickup both find
#     nobody to talk to. Those two need a real session: install, log out,
#     log back in.
nested: install nested-config
	@env XDG_CONFIG_HOME="$(NESTED_CFG)" dbus-run-session -- gnome-shell --devkit

nested-config:
	@rm -rf "$(NESTED_CFG)"
	@mkdir -p "$(NESTED_CFG)/dconf"
	@cp "$${XDG_CONFIG_HOME:-$$HOME/.config}/dconf/user" "$(NESTED_CFG)/dconf/user" 2>/dev/null \
	    || printf "No dconf database to copy; the nested shell starts with defaults.\n"
	@gnome-extensions list --enabled | grep -qx "$(UUID)" \
	    || printf "Note: not enabled here, so the nested shell will not load it.\n      Run 'make enable' first.\n\n"

test-syntax:
	@for f in extension.js prefs.js lib/*.js; do \
	    printf "checking %-25s " "$$f"; \
	    if gjs -c "imports.gi.GLib;" >/dev/null 2>&1; then \
	        node --check "$$f" >/dev/null 2>&1 && printf "OK\n" || { printf "FAIL\n"; node --check "$$f"; exit 1; }; \
	    else \
	        node --check "$$f" >/dev/null 2>&1 && printf "OK\n" || { printf "FAIL\n"; node --check "$$f"; exit 1; }; \
	    fi; \
	done

# Unit tests for the modules that carry no Shell imports (notify-policy,
# watchers). Anything importing resource:///org/gnome/shell/… cannot run
# outside a live session and is covered by the manual checklist instead.
test:
	@gjs -m tests/run.js

# Build the publishable zip. GNOME Shell 45+ compiles schemas itself on
# extension load, so we ship only the raw XML: shipping gschemas.compiled
# is flagged by the EGO review tooling as an unnecessary build artifact.
# store-icon.png stays out: the listing icon is uploaded on the EGO
# website, shipping it in the zip is just an unnecessary file.
pack: translations
	@rm -f "$(ZIPNAME)"
	@cd "$(CURDIR)" && zip -qr "$(ZIPNAME)" \
	    metadata.json extension.js prefs.js stylesheet.css \
	    lib prefs nautilus \
	    icons/hicolor \
	    locale \
	    schemas/org.gnome.shell.extensions.tailscale-gnome.gschema.xml \
	    LICENSE README.md CHANGELOG.md \
	    -x '*__pycache__*'
	@printf "Built %s\n" "$(ZIPNAME)"

clean:
	@rm -f "$(COMPILED)" "$(ZIPNAME)"
	@rm -rf locale nautilus/__pycache__ "$(NESTED_CFG)"
