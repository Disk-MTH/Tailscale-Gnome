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

/**
 * How far a quiet window reaches.
 *
 * SPONTANEOUS silences only what nobody asked for — watcher events and
 * daemon signals — so two user actions in quick succession still both
 * report. This is the pre-existing `hasActiveOp` behaviour.
 *
 * ALL silences everything except `force`, and is used while an account
 * switch churns the whole snapshot.
 */
export const QuietScope = Object.freeze({
    SPONTANEOUS: 'spontaneous',
    ALL:         'all',
});

// Levels that the `errors` switch lets escape a muted category, so muting
// a domain never turns its failures silent.
const ALERT_LEVELS = Object.freeze(['warning', 'error']);

export class NotifyPolicy {
    constructor() {
        this._enabled = new Map();
        this._quiet = new Map();   // token -> QuietScope
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
     * @param {string} scope one of QuietScope
     * @returns {number} token to pass back to endQuiet()
     */
    beginQuiet(scope) {
        const token = this._nextToken++;
        this._quiet.set(token, scope);
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

    _hasScope(scope) {
        for (const s of this._quiet.values()) {
            if (s === scope)
                return true;
        }
        return false;
    }

    /**
     * @param {{category: string, level: string, spontaneous?: boolean,
     *          force?: boolean}} opts
     * @returns {boolean}
     */
    shouldShow({ category, level, spontaneous = false, force = false }) {
        if (!force) {
            if (this._hasScope(QuietScope.ALL))
                return false;
            if (spontaneous && this._hasScope(QuietScope.SPONTANEOUS))
                return false;
        }
        if (this.isCategoryEnabled(category))
            return true;
        // Safety net: a muted domain must not hide its own failures.
        return ALERT_LEVELS.includes(level) &&
            this.isCategoryEnabled(Category.ERRORS);
    }
}
