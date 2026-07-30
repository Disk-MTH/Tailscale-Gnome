// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// Pure notification policy: decides whether a notification is allowed
// through, and tracks the quiet windows that suppress bursts.
//
// Deliberately free of any `resource:///org/gnome/shell/…` import so
// `make test` can exercise the rules outside a Shell session. Everything
// needing Shell APIs lives in notify.js and the two render backends.

/** Notification domains. One GSettings key each — see CATEGORY_KEY. */
export const Category = Object.freeze({
    CONNECTION:     'connection',
    ACCOUNT:        'account',
    PROFILE_SWITCH: 'profile-switch',
    EXIT_NODE:      'exit-node',
    NETWORK:        'network',
    TAILDROP:       'taildrop',
    FUNNEL:         'funnel',
    ERRORS:         'errors',
    MISC:           'misc',
});

export const CATEGORY_KEY = Object.freeze({
    [Category.CONNECTION]:     'notify-connection',
    [Category.ACCOUNT]:        'notify-account',
    [Category.PROFILE_SWITCH]: 'notify-profile-switch',
    [Category.EXIT_NODE]:      'notify-exit-node',
    [Category.NETWORK]:        'notify-network',
    [Category.TAILDROP]:       'notify-taildrop',
    [Category.FUNNEL]:         'notify-funnel',
    [Category.ERRORS]:         'notify-errors',
    [Category.MISC]:           'notify-misc',
});

/**
 * How much of a category is allowed through. Nicks match the schema enum,
 * so the GSettings string goes straight into setCategoryMode().
 *
 * ERRORS is what used to be a single global "always report failures"
 * override: every category now carries its own copy, which is what lets one
 * domain be silent while another still reports only its failures.
 */
export const NotifyMode = Object.freeze({
    ALL:    'all',
    ERRORS: 'errors',
    OFF:    'off',
});

const MODES = new Set(Object.values(NotifyMode));

/** Levels a category in ERRORS mode still lets through. */
const ALERT_LEVELS = Object.freeze(['warning', 'error']);

export class NotifyPolicy {
    constructor() {
        this._modes = new Map();
        this._quiet = new Set();   // open window tokens
        this._nextToken = 1;
    }

    /**
     * An unrecognised mode falls back to ALL rather than silencing the
     * category: a hand-edited or stale dconf value must not be able to turn
     * notifications off behind the user's back.
     *
     * @param {string} category
     * @param {string} mode one of NotifyMode
     */
    setCategoryMode(category, mode) {
        this._modes.set(category, MODES.has(mode) ? mode : NotifyMode.ALL);
    }

    /** Unconfigured categories default to ALL, matching the schema defaults. */
    categoryMode(category) {
        return this._modes.get(category) ?? NotifyMode.ALL;
    }

    /**
     * Open a quiet window.
     *
     * A window silences only what nobody asked for — watcher events and daemon
     * signals, marked `spontaneous` — so two user actions in quick succession
     * still both report. Callers must pair this with endQuiet().
     *
     * @returns {number} token to pass back to endQuiet()
     */
    beginQuiet() {
        const token = this._nextToken++;
        this._quiet.add(token);
        return token;
    }

    /** Idempotent: closing an unknown or already-closed token is a no-op. */
    endQuiet(token) {
        this._quiet.delete(token);
    }

    clearQuiet() {
        this._quiet.clear();
    }

    get quietCount() {
        return this._quiet.size;
    }

    /**
     * @param {{category: string, level: string, spontaneous?: boolean}} opts
     * @returns {boolean}
     */
    shouldShow({ category, level, spontaneous = false }) {
        if (spontaneous && this._quiet.size)
            return false;
        switch (this.categoryMode(category)) {
        case NotifyMode.OFF:
            return false;
        case NotifyMode.ERRORS:
            return ALERT_LEVELS.includes(level);
        default:
            return true;
        }
    }
}
