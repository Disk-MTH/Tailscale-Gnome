// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// Native notification backend: GNOME notifications grouped under a single
// "Tailscale" source, forming a browsable history.
//
// Three GNOME Shell behaviours drive the design (verified in gnome-50
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
//     updated notification: GNOME then mutates the live banner if it is
//     still showing, or queues a fresh one if it is not.
//   - activate() destroys the notification unless `resident` is set, so a
//     click on a passing banner would delete the very entry the history is
//     supposed to keep. Every notification here is therefore resident; the
//     user still clears them the usual way, from the message list.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

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
        // 'destroy' exactly as a plain connect() would; see _ensureSource()
        // below for why the ordering is safe.
        notification.connectObject('destroy', () => {
            this._notification = null;
        }, this);
    }

    update({ message, level }) {
        const n = this._notification;
        if (!n)
            return;   // already dismissed or evicted
        // The message is the body, never the title: see show() below.
        if (message != null)
            n.body = message;
        if (level)
            n.urgency = _urgencyFor(level);
        // Re-banner. Setting the text alone updates the history entry
        // silently; only the acknowledged transition re-emits
        // 'notification-request-banner'.
        n.acknowledged = false;
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
        // run_dispose(), so this handler (connected with normal priority)
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
     * The message goes in the body and the category heading in the title.
     * GNOME's message widget stacks a title label above a body bin and
     * never collapses the bin when the body is empty (gnome-50
     * js/ui/messageList.js), so a title-only notification draws its text
     * against a reserved blank line and reads as top-aligned. Filling both
     * rows is what makes the banner sit correctly.
     *
     * No per-notification icon: the source already carries the Tailscale
     * logo in the banner header, so a second copy would only widen the
     * banner. The one the source shows is set through configure().
     *
     * @param {{message: string, title: string, level?: string,
     *          onActivate?: () => void}} opts
     * @returns {TrayHandle}
     */
    show({ message, title, level = 'info', onActivate = null }) {
        const source = this._ensureSource();

        const params = {
            source,
            title: title || 'Tailscale',
            body: message,
            urgency: _urgencyFor(level),
            // See the header note: without this a click on the banner
            // destroys the entry instead of leaving it in the history.
            resident: true,
        };

        const notification = new MessageTray.Notification(params);
        if (onActivate)
            notification.connectObject('activated', () => onActivate(), this);
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
