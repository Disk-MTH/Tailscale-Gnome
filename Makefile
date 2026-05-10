# Tailscale GNOME Shell extension — build / install / package
# Tested on GNOME Shell 46 → 50.

UUID        := tailscale-gnome@diskmth.github.io
NAME        := Tailscale
USER_EXTDIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA      := schemas/org.gnome.shell.extensions.tailscale-gnome.gschema.xml
COMPILED    := schemas/gschemas.compiled
ZIPNAME     := $(UUID).shell-extension.zip

SOURCES := \
    metadata.json \
    extension.js \
    prefs.js \
    stylesheet.css \
    lib/tailscale.js \
    lib/indicator.js \
    lib/menu.js \
    icons/tailscale-symbolic.svg \
    icons/tailscale-disabled-symbolic.svg \
    $(SCHEMA) \
    $(COMPILED) \
    LICENSE \
    README.md \
    CHANGELOG.md

.PHONY: all schemas install uninstall enable disable reset pack clean test-syntax help

all: schemas

help:
	@printf "Targets:\n"
	@printf "  schemas      Compile the GSettings schema\n"
	@printf "  install      Install to %s\n" "$(USER_EXTDIR)"
	@printf "  uninstall    Remove the installed extension\n"
	@printf "  enable       Enable the extension via gnome-extensions\n"
	@printf "  disable      Disable the extension via gnome-extensions\n"
	@printf "  reset        Reset all preferences (dconf)\n"
	@printf "  pack         Build a publishable .shell-extension.zip\n"
	@printf "  test-syntax  Quick syntax check on every JS file via gjs\n"
	@printf "  clean        Remove generated files\n"

$(COMPILED): $(SCHEMA)
	glib-compile-schemas schemas/

schemas: $(COMPILED)

install: schemas
	@mkdir -p "$(USER_EXTDIR)"
	@cp -r metadata.json extension.js prefs.js stylesheet.css "$(USER_EXTDIR)/"
	@cp -r lib icons schemas "$(USER_EXTDIR)/"
	@cp -r LICENSE README.md CHANGELOG.md "$(USER_EXTDIR)/" 2>/dev/null || true
	@printf "Installed to %s\n" "$(USER_EXTDIR)"
	@printf "Restart GNOME Shell (Xorg: Alt+F2 r ; Wayland: log out / log in)\n"
	@printf "or test in a nested session:  dbus-run-session -- gnome-shell --nested --wayland\n"

uninstall:
	@rm -rf "$(USER_EXTDIR)"
	@printf "Removed %s\n" "$(USER_EXTDIR)"

enable:
	@gnome-extensions enable "$(UUID)"

disable:
	@gnome-extensions disable "$(UUID)"

reset:
	@dconf reset -f /org/gnome/shell/extensions/tailscale-gnome/

test-syntax:
	@for f in extension.js prefs.js lib/*.js; do \
	    printf "checking %-25s " "$$f"; \
	    if gjs -c "imports.gi.GLib;" >/dev/null 2>&1; then \
	        node --check "$$f" >/dev/null 2>&1 && printf "OK\n" || { printf "FAIL\n"; node --check "$$f"; exit 1; }; \
	    else \
	        node --check "$$f" >/dev/null 2>&1 && printf "OK\n" || { printf "FAIL\n"; node --check "$$f"; exit 1; }; \
	    fi; \
	done

pack: schemas
	@rm -f "$(ZIPNAME)"
	@cd "$(CURDIR)" && zip -qr "$(ZIPNAME)" \
	    metadata.json extension.js prefs.js stylesheet.css \
	    lib icons schemas \
	    LICENSE README.md CHANGELOG.md
	@printf "Built %s\n" "$(ZIPNAME)"

clean:
	@rm -f "$(COMPILED)" "$(ZIPNAME)"
