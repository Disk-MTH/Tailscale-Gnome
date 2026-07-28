// Persistent notification backend: native GNOME notifications grouped under
// a single "Tailscale" source, forming a browsable history of the last N
// events.
//
// Three GNOME Shell behaviours drive the design (verified in gnome-50
// js/ui/messageTray.js):
//
//   - A Source *is* the requested queue. addNotification() already evicts
//     the oldest past MAX_NOTIFICATIONS_PER_SOURCE (10); we evict earlier so
//     the configured size wins instead of the hard ceiling.
//   - A Source destroys itself the moment it drops to zero notifications,
//     which happens whenever the user clears the list. The reference must be
//     dropped on 'destroy' and the source rebuilt lazily.
//   - Banner duration is a module constant (4s) that only CRITICAL escapes.
//     It is deliberately left alone: patching a Shell internal is not worth
//     the review risk. Writing acknowledged = false is what re-banners an
//     updated notification — GNOME then mutates the live banner if it is
//     still showing, or queues a fresh one if it is not.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

// Bundled per-level symbolics, pushed in by notify.js via configure().
// Module-scoped because TrayHandle.update() needs them too and deliberately
// holds no reference back to the backend. 'pending' resolves to a static
// glyph: a native notification has no spinner.
let _levelGicons = {};

// Point a notification at the bundled symbolic for `level`.
function _applyLevelIcon(params, level) {
    params.gicon = _levelGicons[level] ?? _levelGicons.info;
}

// Warnings and errors sort ahead of the rest in the banner queue, which
// MessageTray orders by descending urgency. CRITICAL is never used: it makes
// the banner sticky until dismissed, which is disproportionate here.
function _urgencyFor(level) {
    return level === 'warning' || level === 'error'
        ? MessageTray.Urgency.HIGH
        : MessageTray.Urgency.NORMAL;
}

// One live notification. Kept deliberately thin: all it owns is the
// MessageTray.Notification and whether it is still alive.
class TrayHandle {
    constructor(notification) {
        this._notification = notification;
        // connectObject ties this handler's lifetime to `notification`
        // itself (a registered destroyable type): GNOME's SignalTracker
        // disconnects it automatically once the object is gone, so there is
        // no disable()-side counterpart to write. The handler still runs on
        // 'destroy' exactly as a plain connect() would — see _ensureSource()
        // below for why the ordering is safe.
        notification.connectObject('destroy', () => {
            this._notification = null;
        }, this);
    }

    update({ message, level }) {
        const n = this._notification;
        if (!n)
            return;   // already dismissed or evicted
        if (message != null)
            n.title = message;
        if (level) {
            n.urgency = _urgencyFor(level);
            if (!n.gicon)
                _applyLevelIcon(n, level);
        }
        // Re-banner. Setting title alone updates the history entry silently;
        // only the acknowledged transition re-emits
        // 'notification-request-banner'.
        n.acknowledged = false;
    }

    dismiss() {
        this._notification?.destroy(
            MessageTray.NotificationDestroyedReason.DISMISSED);
        this._notification = null;
    }
}

export class TrayBackend {
    constructor() {
        this._source = null;
        this._historySize = 5;
        this._gicon = null;
    }

    /**
     * @param {{historySize?: number, gicon?: Gio.Icon,
     *          levelGicons?: Object<string, Gio.Icon>}} opts
     */
    configure({ historySize, gicon, levelGicons } = {}) {
        if (historySize != null) {
            this._historySize = Math.max(1, Math.min(10, historySize));
            this._trim();
        }
        if (gicon !== undefined) {
            this._gicon = gicon;
            if (this._source)
                this._source.icon = gicon;
        }
        if (levelGicons !== undefined)
            _levelGicons = levelGicons ?? {};
    }

    _ensureSource() {
        if (this._source)
            return this._source;

        const source = new MessageTray.Source({
            title: 'Tailscale',
            icon: this._gicon ?? _levelGicons.info,
        });
        // A source that empties out destroys itself; hold no stale reference.
        // connectObject (see TrayHandle above): Source is also a registered
        // destroyable type, and destroy() emits 'destroy' before it calls
        // run_dispose(), so this handler — connected with normal priority —
        // still fires before SignalTracker's own connect_after cleanup hook
        // on the same object tears the tracked connection down.
        source.connectObject('destroy', () => {
            if (this._source === source)
                this._source = null;
        }, this);
        Main.messageTray.add(source);
        this._source = source;
        return source;
    }

    // Evict oldest-first down to the configured size. Called before every
    // insert and again from configure() so lowering the size takes effect at
    // once rather than on the next notification.
    _trim(headroom = 0) {
        const source = this._source;
        if (!source)
            return;
        while (source.notifications.length > Math.max(0, this._historySize - headroom)) {
            const [oldest] = source.notifications;
            oldest.destroy(MessageTray.NotificationDestroyedReason.EXPIRED);
            // Evicting the last one destroys the source; stop touching it.
            if (!this._source)
                return;
        }
    }

    /**
     * @param {{message: string, level?: string, gicon?: Gio.Icon}} opts
     * @returns {TrayHandle}
     */
    show({ message, level = 'info', gicon = null }) {
        // Make room first: evicting the last entry destroys the source, so
        // the source must be resolved *after* trimming or the notification
        // would be attached to a disposed one.
        this._trim(1);
        const source = this._ensureSource();

        const params = {
            source,
            title: message,
            urgency: _urgencyFor(level),
        };
        const icon = gicon ?? this._gicon;
        if (icon)
            params.gicon = icon;
        else
            _applyLevelIcon(params, level);

        const notification = new MessageTray.Notification(params);
        source.addNotification(notification);
        return new TrayHandle(notification);
    }

    destroy() {
        // Destroying the source destroys every notification it holds.
        this._source?.destroy(
            MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._source = null;
        this._gicon = null;
        _levelGicons = {};
    }
}
