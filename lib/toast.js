// Bottom-of-screen feedback "toasts" rendered with the native Shell OSD
// styling (.osd-window — same look Caffeine and other extensions use), but
// extended with a pending state so long-running operations can show a
// spinner that resolves in place to success / error.
//
// Caffeine just calls Main.osdWindowManager.show() once with the final
// state. We need to update in place (pending → success), so we render our
// own actor and apply the osd-window CSS class to inherit the theme look.
//
// Min spinner duration prevents the "flash" when an action completes
// faster than the user can perceive a state change.

import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as Animation from "resource:///org/gnome/shell/ui/animation.js";

// Older Shell builds might not expose Spinner under this name; fall back to
// rotating-icon mode when it's missing.
const _Spinner = Animation.Spinner ?? null;

const LEVEL_ICONS = {
    pending: "content-loading-symbolic",
    info:    "dialog-information-symbolic",
    success: "object-select-symbolic",
    error:   "dialog-error-symbolic",
};

const _settings = {
    durationMs:  3000,   // overridable via init()
    minSpinnerMs: 1000,
};

let _container = null;
let _live = [];

function _ensureContainer() {
    if (_container && _container.get_parent()) return _container;
    _container = new St.BoxLayout({
        vertical: true,
        reactive: false,
        track_hover: false,
        x_expand: false,
        y_expand: false,
    });
    _container.set_style("spacing: 8px;");
    Main.layoutManager.addTopChrome(_container, {
        affectsInputRegion: false,
        affectsStruts: false,
        trackFullscreen: false,
    });
    _reposition();
    return _container;
}

// Bottom-center on the primary monitor. Native OSD sits roughly 4em from
// the bottom; we pick 8% to land in the same visual zone on tall screens.
function _reposition() {
    if (!_container) return;
    const mon = Main.layoutManager.primaryMonitor;
    if (!mon) return;
    GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        if (!_container) return GLib.SOURCE_REMOVE;
        const [w, h] = _container.get_size();
        const x = mon.x + Math.round((mon.width - w) / 2);
        const y = mon.y + mon.height - h - Math.round(mon.height * 0.08);
        _container.set_position(x, Math.max(mon.y, y));
        return GLib.SOURCE_REMOVE;
    });
}

// Single-line horizontal layout (icon left, label right) with the same
// .osd-window CSS class so the theme-aware background, radius and font
// weight come for free.
const Toast = GObject.registerClass(
    class Toast extends St.BoxLayout {
        _init({ message, level }) {
            super._init({
                style_class: `osd-window tailscale-osd tailscale-osd-${level}`,
                vertical: false,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                reactive: false,
                track_hover: false,
                opacity: 0,
            });
            this._level = level;
            this._timeoutId = 0;
            this._destroyed = false;
            this._createdAt = GLib.get_monotonic_time() / 1000;

            this._iconBin = new St.Bin({
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this._iconBin);

            this._label = new St.Label({
                text: message,
                style_class: "tailscale-osd-label",
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._label.clutter_text.line_wrap = false;
            this._label.clutter_text.ellipsize = 0;  // Pango.EllipsizeMode.NONE
            this.add_child(this._label);

            this._setIcon(level);
        }

        _setIcon(level) {
            // Tear down whatever the bin holds (icon or spinner) and rebuild
            // for the requested level. Spinners get a hard reference so we
            // can call stop() during dismissal.
            if (this._spinner) {
                try { this._spinner.stop(); } catch (_) {}
                this._spinner = null;
            }
            this._iconBin.set_child(null);

            if (level === "pending" && _Spinner) {
                this._spinner = new _Spinner(18, { animate: true });
                this._spinner.play();
                this._iconBin.set_child(this._spinner);
                return;
            }
            const icon = new St.Icon({
                icon_name: LEVEL_ICONS[level] ?? LEVEL_ICONS.info,
                icon_size: 18,
                style_class: `tailscale-osd-icon tailscale-osd-icon-${level}`,
            });
            if (level === "pending") {
                // Spinner module unavailable — rotate the loading icon.
                icon.set_pivot_point(0.5, 0.5);
                const t = new Clutter.PropertyTransition({ property_name: "rotation-angle-z" });
                t.set_from(0); t.set_to(360);
                t.set_duration(900);
                t.set_repeat_count(-1);
                t.set_progress_mode(Clutter.AnimationMode.LINEAR);
                icon.add_transition("spin", t);
            }
            this._iconBin.set_child(icon);
        }

        _switchLevel(level) {
            this.remove_style_class_name(`tailscale-osd-${this._level}`);
            this._level = level;
            this.add_style_class_name(`tailscale-osd-${level}`);
            this._setIcon(level);
        }

        update({ message, level }) {
            if (this._destroyed) return;
            if (message != null) this._label.text = message;
            if (level && level !== this._level) this._switchLevel(level);
            this._arm();
        }

        _arm() {
            if (this._timeoutId) {
                GLib.source_remove(this._timeoutId);
                this._timeoutId = 0;
            }
            if (this._level === "pending") return;  // sticky
            const ms = _settings.durationMs;
            this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                this._timeoutId = 0;
                this.dismiss();
                return GLib.SOURCE_REMOVE;
            });
        }

        present() {
            this.ease({
                opacity: 255,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
            this._arm();
        }

        dismiss() {
            if (this._destroyed) return;
            this._destroyed = true;
            if (this._timeoutId) {
                GLib.source_remove(this._timeoutId);
                this._timeoutId = 0;
            }
            this.ease({
                opacity: 0,
                duration: 180,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    if (this._spinner) {
                        try { this._spinner.stop(); } catch (_) {}
                        this._spinner = null;
                    }
                    const parent = this.get_parent();
                    if (parent) parent.remove_child(this);
                    _live = _live.filter((t) => t !== this);
                    _reposition();
                    this.destroy();
                },
            });
        }
    },
);

export const ToastManager = {
    /**
     * Wire the manager to the extension's GSettings so durations stay
     * reactive. Safe to call multiple times.
     */
    init(settings) {
        if (!settings) return;
        const refresh = () => {
            _settings.durationMs   = settings.get_uint("toast-duration") * 1000;
            _settings.minSpinnerMs = settings.get_uint("toast-min-spinner");
        };
        refresh();
        this._settingsIds = [
            settings.connect("changed::toast-duration",    refresh),
            settings.connect("changed::toast-min-spinner", refresh),
        ];
        this._settings = settings;
    },

    /** Configured minimum spinner duration in ms (read by call sites). */
    get minSpinnerMs() { return _settings.minSpinnerMs; },

    /** Configured final-state display duration in ms. */
    get durationMs() { return _settings.durationMs; },

    /**
     * @param {{message: string, level?: 'pending'|'info'|'success'|'error'}} opts
     * @returns {{update: Function, dismiss: Function, createdAt: number}}
     */
    show({ message, level = "info" }) {
        const container = _ensureContainer();
        const toast = new Toast({ message, level });
        container.add_child(toast);
        _live.push(toast);
        _reposition();
        toast.present();
        return {
            update: (opts) => toast.update(opts),
            dismiss: () => toast.dismiss(),
            createdAt: toast._createdAt,
        };
    },

    destroy() {
        if (this._settings && this._settingsIds) {
            for (const id of this._settingsIds) this._settings.disconnect(id);
            this._settingsIds = null;
            this._settings = null;
        }
        for (const t of _live.slice()) t.dismiss();
        _live = [];
        if (_container) {
            try { Main.layoutManager.removeChrome(_container); } catch (_) {}
            _container.destroy();
            _container = null;
        }
    },
};
