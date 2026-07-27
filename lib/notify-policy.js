// Pure notification policy: decides whether a notification is allowed
// through, and tracks the quiet windows that suppress bursts.
//
// Deliberately free of any `resource:///org/gnome/shell/…` import so
// `make test` can exercise the rules outside a Shell session. Everything
// needing Shell APIs lives in notify.js and the two render backends.

/** Notification domains. One GSettings switch each — see CATEGORY_KEY. */
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

// Levels that the `errors` switch lets escape a muted category, so muting
// a domain never turns its failures silent.
const ALERT_LEVELS = Object.freeze(['warning', 'error']);

export class NotifyPolicy {
    constructor() {
        this._enabled = new Map();
        this._quiet = new Set();   // open window tokens
        this._nextToken = 1;
    }

    /** @param {string} category @param {boolean} enabled */
    setCategoryEnabled(category, enabled) {
        this._enabled.set(category, !!enabled);
    }

    /** Unconfigured categories default to on, matching the schema defaults. */
    isCategoryEnabled(category) {
        return this._enabled.get(category) ?? true;
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
        if (this.isCategoryEnabled(category))
            return true;
        // Safety net: a muted domain must not hide its own failures.
        return ALERT_LEVELS.includes(level) &&
            this.isCategoryEnabled(Category.ERRORS);
    }
}
