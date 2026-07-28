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
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Animation from 'resource:///org/gnome/shell/ui/animation.js';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

// Pushed in by notify.js via ToastBackend.configure(); this module never
// reads GSettings itself.
const _settings = {
    durationMs: 3000,
};

let _container = null;
let _live = [];
let _successGicon = null;  // optional Gio.Icon used for the success state
// Bundled per-level symbolics, pushed in by notify.js via configure().
// Keyed by level; 'pending' has no entry on purpose, since it renders an
// Animation.Spinner and never reaches this lookup. Unlike the brand logo
// these are single-ink symbolics, so they still take the level tint.
let _levelGicons = {};
let _repositionId = 0;

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
// the source id is tracked and removed in ToastBackend.destroy().
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
            this._spinner = null;

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
            // The brand logo (per-toast gicon, or the configured one on
            // success) carries its own colour intent: the level tint
            // (.tailscale-osd-icon-info etc.) would recolour it to blue/red
            // and look wrong. Every other source is a single-ink symbolic
            // and does take the tint.
            const brandGicon = this._gicon ?? (level === 'success' ? _successGicon : null);
            const iconProps = { icon_size: 18 };
            if (brandGicon) {
                iconProps.gicon = brandGicon;
                iconProps.style_class = 'tailscale-osd-icon';
            } else {
                iconProps.style_class =
                    `tailscale-osd-icon tailscale-osd-icon-${level}`;
                iconProps.gicon = _levelGicons[level] ?? _levelGicons.info;
            }
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

// Transient on-screen backend. Reduced to pure rendering: the policy layer
// in notify.js owns the GSettings subscription, the category filter, the
// quiet stack and withFeedback, and pushes the only value this module needs
// through configure().
export class ToastBackend {
    /**
     * @param {{durationMs?: number, gicon?: Gio.Icon,
     *          levelGicons?: Object<string, Gio.Icon>}} opts
     */
    configure({ durationMs, gicon, levelGicons } = {}) {
        if (durationMs != null)
            _settings.durationMs = durationMs;
        if (gicon !== undefined)
            _successGicon = gicon;
        if (levelGicons !== undefined)
            _levelGicons = levelGicons ?? {};
    }

    /**
     * @param {{message: string, level?: string, gicon?: Gio.Icon}} opts
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
    }

    destroy() {
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
        _levelGicons = {};
    }
}
