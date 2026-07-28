# Tailscale GNOME Shell extension — build / install / package
# Tested on GNOME Shell 46 → 50.

UUID        := tailscale-gnome@diskmth.fr
NAME        := Tailscale
URL         := https://github.com/Disk-MTH/Tailscale-Gnome
USER_EXTDIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
SCHEMA      := schemas/org.gnome.shell.extensions.tailscale-gnome.gschema.xml
COMPILED    := schemas/gschemas.compiled
ZIPNAME     := $(UUID).shell-extension.zip

# Translations. The domain must match metadata.json's "gettext-domain";
# GNOME Shell 45+ binds it to <extension>/locale/ on its own.
DOMAIN      := tailscale-gnome
POT         := po/$(DOMAIN).pot
SOURCES     := extension.js prefs.js $(wildcard lib/*.js)
PO_FILES    := $(wildcard po/*.po)
MO_FILES    := $(patsubst po/%.po,locale/%/LC_MESSAGES/$(DOMAIN).mo,$(PO_FILES))

.PHONY: all schemas install uninstall enable disable reset pack clean test test-syntax help \
        translations pot update-po

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

install: schemas translations
	@mkdir -p "$(USER_EXTDIR)"
	@cp -r metadata.json extension.js prefs.js stylesheet.css "$(USER_EXTDIR)/"
	@cp -r lib icons schemas nautilus "$(USER_EXTDIR)/"
	@cp -r locale "$(USER_EXTDIR)/" 2>/dev/null || true
	@cp -r LICENSE README.md CHANGELOG.md "$(USER_EXTDIR)/" 2>/dev/null || true
	@printf "Installed to %s\n" "$(USER_EXTDIR)"
	@printf "Restart GNOME Shell (Xorg: Alt+F2 r ; Wayland: log out / log in)\n"
	@printf "or test in a nested session:  dbus-run-session -- gnome-shell --devkit\n"

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

# Unit tests for the modules that carry no Shell imports (notify-policy,
# watchers). Anything importing resource:///org/gnome/shell/… cannot run
# outside a live session and is covered by the manual checklist instead.
test:
	@gjs -m tests/run.js

# Build the publishable zip. GNOME Shell 45+ compiles schemas itself on
# extension load, so we ship only the raw XML — shipping gschemas.compiled
# is flagged by the EGO review tooling as an unnecessary build artifact.
# store-icon.png stays out: the listing icon is uploaded on the EGO
# website, shipping it in the zip is just an unnecessary file.
pack: translations
	@rm -f "$(ZIPNAME)"
	@cd "$(CURDIR)" && zip -qr "$(ZIPNAME)" \
	    metadata.json extension.js prefs.js stylesheet.css \
	    lib nautilus \
	    icons/hicolor \
	    locale \
	    schemas/org.gnome.shell.extensions.tailscale-gnome.gschema.xml \
	    LICENSE README.md CHANGELOG.md
	@printf "Built %s\n" "$(ZIPNAME)"

clean:
	@rm -f "$(COMPILED)" "$(ZIPNAME)"
	@rm -rf locale
