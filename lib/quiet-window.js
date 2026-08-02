// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// The quiet window opened around an account switch.
//
// The daemon churns for a few seconds after a switch — exit node, backend
// state, the tailnet's own capability flips — and none of that is worth
// reporting to someone who just asked for it. This owns the two timeouts
// that decide when the churn is over: a debounce pushed back on every
// snapshot, so the window lasts as long as the daemon keeps changing its
// mind, and a hard ceiling so a daemon that never settles cannot leave the
// extension permanently silent.

import GLib from 'gi://GLib';

import { Notifier } from './notify.js';

// Longest a window may stay open, however unsettled the daemon is.
const CEILING_SECONDS = 30;

export class QuietWindow {
    constructor() {
        this._token = 0;
        this._debounceId = 0;
        this._ceilingId = 0;
    }

    /**
     * Open the window, or restart it when one is already open: a switch
     * during a switch is one longer silence, not two overlapping ones.
     *
     * @param {number} settleMs how quiet the daemon must go to close it
     */
    open(settleMs) {
        // Also the removal paired with the timeout created just below —
        // close() drops both sources and the token in one place.
        this.close();
        this._token = Notifier.beginQuiet();
        this._ceilingId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, CEILING_SECONDS, () => {
                this._ceilingId = 0;
                this.close();
                return GLib.SOURCE_REMOVE;
            });
        this.postpone(settleMs);
    }

    /**
     * Push the close back. A no-op when no window is open, so every
     * snapshot can call it unconditionally.
     *
     * @param {number} settleMs
     */
    postpone(settleMs) {
        if (!this._token) return;
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
        this._debounceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, settleMs, () => {
                this._debounceId = 0;
                this.close();
                return GLib.SOURCE_REMOVE;
            });
    }

    /** Close it now. Idempotent: both timeouts and disable() land here. */
    close() {
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
        if (this._ceilingId) {
            GLib.source_remove(this._ceilingId);
            this._ceilingId = 0;
        }
        if (this._token) {
            Notifier.endQuiet(this._token);
            this._token = 0;
        }
    }
}
