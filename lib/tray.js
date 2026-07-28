// Native notification backend: GNOME notifications grouped under a single
// "Tailscale" source, forming a browsable history.
//
// Two GNOME Shell behaviours drive the design (verified in gnome-50
// js/ui/messageTray.js):
//
//   - A Source *is* the queue, and addNotification() already evicts the
//     oldest past MAX_NOTIFICATIONS_PER_SOURCE (10). That ceiling is left
//     to the shell rather than second-guessed here.
//   - A Source destroys itself the moment it drops to zero notifications,
//     which happens whenever the user clears the list. The reference must be
//     dropped on 'destroy' and the source rebuilt lazily.
//   - Banner duration is a module constant (4s) that only CRITICAL escapes.
//     It is deliberately left alone: patching a Shell internal is not worth
//     the review risk. Writing acknowledged = false is what re-banners an
//     updated notification — GNOME then mutates the live banner if it is
//     still showing, or queues a fresh one if it is not.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

// Themed symbolic per level, resolved from the user's icon theme.
// 'pending' resolves to a static glyph: a native notification has no
// spinner.
const LEVEL_ICONS = {
    pending: 'content-loading-symbolic',
    info:    'dialog-information-symbolic',
    success: 'object-select-symbolic',
    warning: 'dialog-warning-symbolic',
    error:   'dialog-error-symbolic',
};

// Point a notification at the themed icon for `level`.
function _applyLevelIcon(params, level) {
    params.iconName = LEVEL_ICONS[level] ?? LEVEL_ICONS.info;
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
        this._gicon = null;
    }

    /**
     * @param {{gicon?: Gio.Icon}} opts
     */
    configure({ gicon } = {}) {
        if (gicon !== undefined) {
            this._gicon = gicon;
            if (this._source)
                this._source.icon = gicon;
        }
    }

    _ensureSource() {
        if (this._source)
            return this._source;

        const source = new MessageTray.Source({
            title: 'Tailscale',
            icon: this._gicon ?? new Gio.ThemedIcon({ name: 'network-vpn-symbolic' }),
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

    /**
     * @param {{message: string, level?: string, gicon?: Gio.Icon}} opts
     * @returns {TrayHandle}
     */
    show({ message, level = 'info', gicon = null }) {
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
    }
}
