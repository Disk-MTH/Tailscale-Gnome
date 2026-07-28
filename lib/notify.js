// The one module notification call sites import.
//
// Decides whether a notification is allowed through (category filter and
// quiet windows, both in the pure notify-policy module), then routes it to
// whichever backend the user picked. Backends never read GSettings and never
// know about categories; this module pushes them what they need.

import GLib from 'gi://GLib';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Category, CATEGORY_KEY, NotifyPolicy } from './notify-policy.js';
import { TrayBackend } from './tray.js';
import { ToastBackend } from './toast.js';
import { gicon as _gicon } from './util.js';

export { Category };

// Bundled symbolic shown for each notification level when no brand logo
// applies. 'pending' only reaches the tray backend — the toast renders an
// Animation.Spinner for it instead.
const LEVEL_ICON_NAMES = {
    pending: 'status-pending-symbolic',
    info:    'status-info-symbolic',
    success: 'status-success-symbolic',
    warning: 'status-warning-symbolic',
    error:   'status-error-symbolic',
};

// Returned when a notification is filtered out, so callers can hold a handle
// unconditionally. Returning null instead would put a nullity check on every
// site that later calls update(), and one missed check is a TypeError inside
// a main-loop callback.
const NOOP_HANDLE = Object.freeze({
    update() {},
    dismiss() {},
    get isNoop() { return true; },
});

const MODE_PERSISTENT = 'persistent';

export const Notifier = {
    /**
     * @param {Gio.Settings} settings
     * @param {{extension?: object}} [opts]
     */
    init(settings, opts = {}) {
        this._settings = settings;
        this._policy = new NotifyPolicy();
        this._tray = new TrayBackend();
        this._toast = new ToastBackend();
        this._floorIds = new Set();
        this._destroyed = false;
        this._gicon = null;
        this._levelGicons = {};
        // Per-category in-flight counter for withFeedback(). A counter, not
        // a boolean: two concurrent withFeedback calls in the same category
        // must not have the first one's completion clear the second one's
        // flag. isCategoryBusy() lets other code (the account-switch quiet
        // window in extension.js) yield to a caller-driven report instead
        // of duplicating it.
        this._categoryBusy = new Map();

        if (opts.extension) {
            this._gicon = _gicon(opts.extension, 'tailscale-symbolic');
            this._levelGicons = Object.fromEntries(
                Object.entries(LEVEL_ICON_NAMES).map(([level, name]) => [
                    level, _gicon(opts.extension, name),
                ]),
            );
        }

        const refreshCategories = () => {
            for (const [category, key] of Object.entries(CATEGORY_KEY))
                this._policy.setCategoryEnabled(category, settings.get_boolean(key));
        };
        const refreshBackends = () => {
            this._tray.configure({
                historySize: settings.get_uint('notification-history-size'),
                gicon: this._gicon,
                levelGicons: this._levelGicons,
            });
            this._toast.configure({
                durationMs: settings.get_uint('toast-duration') * 1000,
                gicon: this._gicon,
                levelGicons: this._levelGicons,
            });
        };
        refreshCategories();
        refreshBackends();

        settings.connectObject(
            'changed::notification-history-size', refreshBackends,
            'changed::toast-duration',            refreshBackends,
            ...Object.values(CATEGORY_KEY).flatMap((key) => [
                `changed::${key}`,
                refreshCategories,
            ]),
            this,
        );
    },

    /** The Tailscale icon, or null before init(). */
    get icon() {
        return this._gicon;
    },

    // Optional chaining so this getter is safe standing on its own: today
    // notify() always hits a nulled _policy first post-destroy, but that
    // ordering should not be load-bearing for this read too.
    get _backend() {
        return this._settings?.get_string('notification-mode') === MODE_PERSISTENT
            ? this._tray
            : this._toast;
    },

    /**
     * @param {{category: string, message: string, level?: string,
     *          gicon?: Gio.Icon, spontaneous?: boolean}} opts
     * @returns {{update: Function, dismiss: Function, isNoop?: boolean}} always a usable
     *          handle. isNoop is true only on the filtered NOOP_HANDLE; withFeedback
     *          relies on it to detect a filtered pending notification and create the
     *          real one late. A genuine handle must never set it.
     */
    notify({ category, message, level = 'info', gicon = null,
             spontaneous = false }) {
        // A torn-down manager has no _policy and no backends. Returning here
        // (rather than only guarding the policy read) is load-bearing: the
        // whole point is that this path must never reach this._backend.show()
        // and register a fresh MessageTray.Source with the shell post-disable.
        if (this._destroyed)
            return NOOP_HANDLE;
        if (!this._policy.shouldShow({ category, level, spontaneous }))
            return NOOP_HANDLE;
        return this._backend.show({ message, level, gicon });
    },

    /**
     * Open a quiet window. Callers must pair this with endQuiet().
     *
     * @returns {number} token
     */
    beginQuiet() {
        return this._policy?.beginQuiet() ?? 0;
    },

    endQuiet(token) {
        this._policy?.endQuiet(token);
    },

    /**
     * Whether a withFeedback() call for this category is currently in
     * flight (between the call and its final update/notify). Lets a
     * caller-driven report suppress a duplicate spontaneous summary of the
     * same outcome, without the quiet-window machinery having to reach
     * back into the operation that opened it.
     *
     * @param {string} category one of Category
     * @returns {boolean}
     */
    isCategoryBusy(category) {
        return (this._categoryBusy.get(category) ?? 0) > 0;
    },

    // Hold the pending state for at least the configured floor so an instant
    // operation does not flash from "doing it" to "done". Applies to both
    // modes: a native banner mutating in 80ms is just as unreadable as a
    // toast doing it.
    async _awaitFloor(startMs) {
        const floor = this._settings.get_uint('toast-min-spinner');
        const wait = floor - (GLib.get_monotonic_time() / 1000 - startMs);
        if (wait <= 0)
            return;
        await new Promise((resolve) => {
            const id = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT, Math.ceil(wait), () => {
                    this._floorIds.delete(id);
                    resolve();
                    return GLib.SOURCE_REMOVE;
                });
            this._floorIds.add(id);
        });
    },

    /**
     * Run an async operation behind a pending notification that resolves in
     * place to success or error.
     *
     * @param {string} category one of Category
     * @param {string} pendingMsg
     * @param {string} successMsg
     * @param {() => Promise<{ok?: boolean, message?: string}|void>} fn
     */
    async withFeedback(category, pendingMsg, successMsg, fn) {
        // Marks this category busy for the whole call, released in the
        // finally below on every exit path: normal completion, fn()
        // throwing (already caught inside), and both early `return result`
        // guards taken when destroy() runs while the operation is still in
        // flight. Never left incremented — a stuck count would silently
        // suppress every future spontaneous summary for the category.
        this._categoryBusy.set(category, (this._categoryBusy.get(category) ?? 0) + 1);
        try {
            const quiet = this.beginQuiet();
            // A user-initiated operation is not spontaneous, so it crosses its
            // own window — and any other open one — untouched. That is what
            // keeps the second of two quick actions from being swallowed.
            let handle = this.notify({
                category, level: 'pending', message: pendingMsg,
            });
            const startMs = GLib.get_monotonic_time() / 1000;

            let result;
            try {
                result = await fn();
            } catch (e) {
                result = { ok: false, message: String(e.message ?? e) };
            }

            // destroy() may run while fn() is still in flight (extension disabled
            // or unloaded mid-operation): _settings, _policy and the backends are
            // all null from here on. fn() already ran, so its result still goes
            // back to the caller — there is just nothing left to notify with, so
            // skip every remaining step that would touch torn-down state.
            if (this._destroyed)
                return result;
            await this._awaitFloor(startMs);
            if (this._destroyed)
                return result;
            this.endQuiet(quiet);

            const failed = !!(result && result.ok === false);
            const level = failed ? 'error' : 'success';
            const message = failed
                ? (result.message || _('Operation failed'))
                : successMsg;

            // The pending state may have been filtered while the result is not:
            // muting a category still lets its failures through (notify-errors).
            // Create the notification late in that case rather than swallowing a
            // failure the user asked to see.
            if (handle.isNoop)
                handle = this.notify({ category, level, message });
            else
                handle.update({ level, message });

            return result;
        } finally {
            const n = this._categoryBusy.get(category);
            if (n !== undefined) {
                if (n <= 1)
                    this._categoryBusy.delete(category);
                else
                    this._categoryBusy.set(category, n - 1);
            }
        }
    },

    destroy() {
        this._destroyed = true;
        this._settings?.disconnectObject(this);
        for (const id of this._floorIds)
            GLib.source_remove(id);
        this._floorIds.clear();
        this._categoryBusy.clear();
        this._policy?.clearQuiet();
        this._tray?.destroy();
        this._toast?.destroy();
        this._tray = null;
        this._toast = null;
        this._policy = null;
        this._settings = null;
        this._gicon = null;
        this._levelGicons = {};
    },
};
