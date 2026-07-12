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

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

const LEVEL_ICONS = {
    pending: 'content-loading-symbolic',
    info:    'dialog-information-symbolic',
    success: 'object-select-symbolic',
    warning: 'dialog-warning-symbolic',
    error:   'dialog-error-symbolic',
};

const _settings = {
    durationMs:  3000,   // overridable via init()
    minSpinnerMs: 1000,
};

let _container = null;
let _live = [];
let _successGicon = null;  // optional Gio.Icon used for the success state
let _repositionId = 0;
let _activeOps = 0;
const _floorTimeoutIds = new Set();

function _ensureContainer() {
    if (_container && _container.get_parent()) return _container;
    _container = new St.BoxLayout({
        vertical: true,
        reactive: false,
        track_hover: false,
        x_expand: false,
        y_expand: false,
    });
    // Tight stack: native OSD bubbles already carry their own breathing
    // room; 4px keeps adjacent toasts visibly distinct without inflating
    // the column when several stack at once.
    _container.set_style('spacing: 4px;');
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
// The layout pass runs from an idle source so the container has a size;
// the source id is tracked and removed in ToastManager.destroy().
function _reposition() {
    if (!_container) return;
    const mon = Main.layoutManager.primaryMonitor;
    if (!mon) return;
    if (_repositionId) GLib.source_remove(_repositionId);
    _repositionId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        _repositionId = 0;
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
//
// Lifecycle: a toast is "live" while it sits in the module-level _live
// list. dismiss() removes it from the list first, so a second dismiss()
// (or an update() arriving during the fade-out) is a no-op — no boolean
// destroyed-flag needed. The auto-dismiss timeout is also removed in the
// 'destroy' handler so tearing the container down cannot leak a source.
const Toast = GObject.registerClass(
    class Toast extends St.BoxLayout {
        _init({ message, level, gicon = null }) {
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

            this.connect('destroy', () => {
                if (this._timeoutId) {
                    GLib.source_remove(this._timeoutId);
                    this._timeoutId = 0;
                }
                this._spinner = null;
            });

            this._iconBin = new St.Bin({
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this._iconBin);

            this._label = new St.Label({
                text: message,
                style_class: 'tailscale-osd-label',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._label.clutter_text.line_wrap = false;
            this._label.clutter_text.ellipsize = 0;  // Pango.EllipsizeMode.NONE
            this.add_child(this._label);

            this._gicon = gicon;
            this._setIcon(level);
        }

        _setIcon(level) {
            // Tear down whatever the bin holds (icon or spinner) and rebuild
            // for the requested level. Spinners get a hard reference so we
            // can call stop() during dismissal.
            if (this._spinner) {
                this._spinner.stop();
                this._spinner = null;
            }
            this._iconBin.set_child(null);

            if (level === 'pending') {
                this._spinner = new Animation.Spinner(18, { animate: true });
                this._spinner.play();
                this._iconBin.set_child(this._spinner);
                return;
            }
            const resolvedGicon = this._gicon ?? (level === 'success' ? _successGicon : null);
            // Custom gicons (e.g. the Tailscale logo) carry their own colour
            // intent; the level-specific tint (.tailscale-osd-icon-info etc.)
            // would recolour the symbolic SVG to blue/red and look wrong.
            // Only apply the level tint when we fall back to the generic
            // named symbolic for that level.
            const iconProps = {
                icon_size: 18,
                style_class: resolvedGicon
                    ? 'tailscale-osd-icon'
                    : `tailscale-osd-icon tailscale-osd-icon-${level}`,
            };
            if (resolvedGicon)
                iconProps.gicon = resolvedGicon;
            else
                iconProps.icon_name = LEVEL_ICONS[level] ?? LEVEL_ICONS.info;
            this._iconBin.set_child(new St.Icon(iconProps));
        }

        _switchLevel(level) {
            this.remove_style_class_name(`tailscale-osd-${this._level}`);
            this._level = level;
            this.add_style_class_name(`tailscale-osd-${level}`);
            this._setIcon(level);
        }

        update({ message, level }) {
            if (!_live.includes(this)) return;  // already dismissed
            if (message != null) this._label.text = message;
            if (level && level !== this._level) this._switchLevel(level);
            this._arm();
        }

        _arm() {
            if (this._timeoutId) {
                GLib.source_remove(this._timeoutId);
                this._timeoutId = 0;
            }
            if (this._level === 'pending') return;  // sticky
            this._timeoutId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, _settings.durationMs, () => {
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
            const idx = _live.indexOf(this);
            if (idx === -1) return;  // already dismissed
            _live.splice(idx, 1);
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
                        this._spinner.stop();
                        this._spinner = null;
                    }
                    this.get_parent()?.remove_child(this);
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
     * reactive.
     *
     * @param {Gio.Settings} settings
     * @param {{ extension?: import('resource:///org/gnome/shell/extensions/extension.js').Extension }} [opts]
     */
    init(settings, opts = {}) {
        const refresh = () => {
            _settings.durationMs   = settings.get_uint('toast-duration') * 1000;
            _settings.minSpinnerMs = settings.get_uint('toast-min-spinner');
        };
        refresh();
        settings.connectObject(
            'changed::toast-duration',    refresh,
            'changed::toast-min-spinner', refresh,
            this,
        );
        this._settings = settings;

        if (opts.extension) {
            _successGicon = new Gio.FileIcon({
                file: opts.extension.dir
                    .get_child('icons')
                    .get_child('tailscale-symbolic.svg'),
            });
        }
    },

    /** The Tailscale icon Gio.Icon, or null before init(). */
    get tailscaleIcon() { return _successGicon; },

    /**
     * True while at least one withFeedback() operation is in flight.
     * Callers use it to suppress duplicate toasts for signal-emitted
     * feedback that belongs to a user-initiated operation.
     */
    get hasActiveOp() { return _activeOps > 0; },

    /**
     * @param {{message: string, level?: 'pending'|'info'|'success'|'warning'|'error', gicon?: Gio.Icon}} opts
     * @returns {Toast} handle with update({message, level}) and dismiss()
     */
    show({ message, level = 'info', gicon = null }) {
        const container = _ensureContainer();
        const toast = new Toast({ message, level, gicon });
        container.add_child(toast);
        _live.push(toast);
        _reposition();
        toast.present();
        return toast;
    },

    /**
     * Run an async operation behind a pending toast that resolves in
     * place to success / error. Enforces the configured minimum spinner
     * visibility so instant operations don't flash. The floor timeout is
     * tracked and removed in destroy(), which also parks the awaiting
     * promise forever — so no callback can run after disable().
     *
     * @param {string} pendingMsg
     * @param {string} successMsg
     * @param {() => Promise<{ok?: boolean, message?: string}|void>} fn
     */
    async withFeedback(pendingMsg, successMsg, fn) {
        const toast = this.show({ level: 'pending', message: pendingMsg });
        _activeOps++;
        const startMs = GLib.get_monotonic_time() / 1000;
        let result;
        try {
            result = await fn();
        } catch (e) {
            result = { ok: false, message: String(e.message ?? e) };
        }
        const wait = _settings.minSpinnerMs -
            (GLib.get_monotonic_time() / 1000 - startMs);
        if (wait > 0) {
            await new Promise((resolve) => {
                const id = GLib.timeout_add(
                    GLib.PRIORITY_DEFAULT, Math.ceil(wait), () => {
                        _floorTimeoutIds.delete(id);
                        resolve();
                        return GLib.SOURCE_REMOVE;
                    });
                _floorTimeoutIds.add(id);
            });
        }
        _activeOps = Math.max(0, _activeOps - 1);
        if (result && result.ok === false) {
            toast.update({
                level: 'error',
                message: result.message || _('Operation failed'),
            });
        } else {
            toast.update({ level: 'success', message: successMsg });
        }
        return result;
    },

    destroy() {
        if (this._settings) {
            this._settings.disconnectObject(this);
            this._settings = null;
        }
        for (const id of _floorTimeoutIds) GLib.source_remove(id);
        _floorTimeoutIds.clear();
        _activeOps = 0;
        if (_repositionId) {
            GLib.source_remove(_repositionId);
            _repositionId = 0;
        }
        // Destroying the container destroys every child toast; each one
        // removes its own auto-dismiss timeout in its 'destroy' handler.
        _live = [];
        if (_container) {
            Main.layoutManager.removeChrome(_container);
            _container.destroy();
            _container = null;
        }
        _successGicon = null;
    },
};
