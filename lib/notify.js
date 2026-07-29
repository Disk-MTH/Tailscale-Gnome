// The one module notification call sites import.
//
// Decides whether a notification is allowed through (category filter and
// quiet windows, both in the pure notify-policy module), then hands it to
// the notification backend. The backend never reads GSettings and never
// knows about categories; this module pushes it what it needs.

import GLib from 'gi://GLib';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Category, CATEGORY_KEY, NotifyPolicy } from './notify-policy.js';
import { TrayBackend } from './tray.js';
import { gicon as _gicon } from './util.js';

export { Category };

// Short heading for each category. GNOME's notification widget stacks a
// title above a body and never collapses the body row, so a notification
// carrying only a title renders its text against an empty line and reads
// as top-aligned. Filling both rows is what makes the banner sit right —
// and the category is genuine information rather than padding.
const CATEGORY_TITLE = {
    [Category.CONNECTION]:     () => _('Connection'),
    [Category.ACCOUNT]:        () => _('Account'),
    [Category.PROFILE_SWITCH]: () => _('Tailnet'),
    [Category.EXIT_NODE]:      () => _('Exit node'),
    [Category.NETWORK]:        () => _('Network'),
    [Category.TAILDROP]:       () => _('Taildrop'),
    [Category.FUNNEL]:         () => _('Funnel'),
    [Category.ERRORS]:         () => _('Error'),
    [Category.MISC]:           () => 'Tailscale',
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

export const Notifier = {
    /**
     * @param {Gio.Settings} settings
     * @param {{extension?: object}} [opts]
     */
    init(settings, opts = {}) {
        this._settings = settings;
        this._policy = new NotifyPolicy();
        this._tray = new TrayBackend();
        this._floorIds = new Set();
        this._destroyed = false;
        this._gicon = null;
        // Per-category in-flight counter for withFeedback(). A counter, not
        // a boolean: two concurrent withFeedback calls in the same category
        // must not have the first one's completion clear the second one's
        // flag. isCategoryBusy() lets other code (the account-switch quiet
        // window in extension.js) yield to a caller-driven report instead
        // of duplicating it.
        this._categoryBusy = new Map();

        if (opts.extension)
            this._gicon = _gicon(opts.extension, 'tailscale-symbolic');

        const refreshCategories = () => {
            for (const [category, key] of Object.entries(CATEGORY_KEY))
                this._policy.setCategoryEnabled(category, settings.get_boolean(key));
        };
        refreshCategories();
        this._tray.configure({ gicon: this._gicon });

        settings.connectObject(
            ...Object.values(CATEGORY_KEY).flatMap((key) => [
                `changed::${key}`,
                refreshCategories,
            ]),
            this,
        );
    },

    /**
     * `onActivate` runs when the user clicks the notification.
     *
     * @param {{category: string, message: string, level?: string,
     *          spontaneous?: boolean, onActivate?: () => void}} opts
     * @returns {{update: Function, dismiss: Function, isNoop?: boolean}} always a usable
     *          handle. isNoop is true only on the filtered NOOP_HANDLE; withFeedback
     *          relies on it to detect a filtered pending notification and create the
     *          real one late. A genuine handle must never set it.
     */
    notify({ category, message, level = 'info',
             spontaneous = false, onActivate = null }) {
        // A torn-down manager has no _policy and no backends. Returning here
        // (rather than only guarding the policy read) is load-bearing: the
        // whole point is that this path must never reach this._tray.show()
        // and register a fresh MessageTray.Source with the shell post-disable.
        if (this._destroyed)
            return NOOP_HANDLE;
        if (!this._policy.shouldShow({ category, level, spontaneous }))
            return NOOP_HANDLE;
        return this._tray.show({
            message, level, onActivate,
            title: (CATEGORY_TITLE[category] ?? CATEGORY_TITLE[Category.MISC])(),
        });
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
    // operation does not flash from "doing it" to "done": a banner that
    // mutates in 80ms is not readable.
    async _awaitFloor(startMs) {
        const floor = this._settings.get_uint('min-pending-duration');
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
            // or unloaded mid-operation): _settings, _policy and the backend are
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
        this._tray = null;
        this._policy = null;
        this._settings = null;
        this._gicon = null;
    },
};
