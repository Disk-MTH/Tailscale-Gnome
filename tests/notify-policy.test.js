import { suite, test, assertTrue, assertFalse, assertEq } from './harness.js';
import { Category, CATEGORY_KEY, QuietScope, NotifyPolicy } from '../lib/notify-policy.js';

const show = (policy, opts) => policy.shouldShow({
    category: Category.TAILDROP, level: 'info', ...opts,
});

suite('NotifyPolicy', () => {
    test('every category maps to a GSettings key', () => {
        for (const category of Object.values(Category))
            assertEq(typeof CATEGORY_KEY[category], 'string', `key for ${category}`);
    });

    test('categories default to enabled', () => {
        const p = new NotifyPolicy();
        assertTrue(show(p, {}), 'unconfigured category passes');
    });

    test('a disabled category is filtered', () => {
        const p = new NotifyPolicy();
        p.setCategoryEnabled(Category.TAILDROP, false);
        assertFalse(show(p, {}), 'info in a muted category is dropped');
    });

    test('errors pass through a muted category', () => {
        const p = new NotifyPolicy();
        p.setCategoryEnabled(Category.TAILDROP, false);
        assertTrue(show(p, { level: 'error' }), 'error escapes via notify-errors');
        assertTrue(show(p, { level: 'warning' }), 'warning escapes via notify-errors');
    });

    test('muting errors closes the safety net', () => {
        const p = new NotifyPolicy();
        p.setCategoryEnabled(Category.TAILDROP, false);
        p.setCategoryEnabled(Category.ERRORS, false);
        assertFalse(show(p, { level: 'error' }), 'no escape once errors are muted');
    });

    test('an enabled category shows errors regardless of notify-errors', () => {
        const p = new NotifyPolicy();
        p.setCategoryEnabled(Category.ERRORS, false);
        assertTrue(show(p, { level: 'error' }), 'own category still wins');
    });

    test('a spontaneous window mutes only spontaneous notifications', () => {
        const p = new NotifyPolicy();
        p.beginQuiet(QuietScope.SPONTANEOUS);
        assertFalse(show(p, { spontaneous: true }), 'spontaneous is muted');
        assertTrue(show(p, { spontaneous: false }), 'user action still passes');
    });

    test('an all window mutes everything', () => {
        const p = new NotifyPolicy();
        p.beginQuiet(QuietScope.ALL);
        assertFalse(show(p, { spontaneous: false }), 'user action is muted too');
        assertFalse(show(p, { spontaneous: true }), 'spontaneous is muted');
    });

    test('force bypasses quiet but never the category filter', () => {
        const p = new NotifyPolicy();
        p.beginQuiet(QuietScope.ALL);
        assertTrue(show(p, { force: true }), 'force escapes the quiet window');
        p.setCategoryEnabled(Category.TAILDROP, false);
        assertFalse(show(p, { force: true }), 'force does not override a muted category');
    });

    test('quiet windows nest and release by token', () => {
        const p = new NotifyPolicy();
        const a = p.beginQuiet(QuietScope.ALL);
        const b = p.beginQuiet(QuietScope.ALL);
        assertEq(p.quietCount, 2, 'two windows open');
        p.endQuiet(a);
        assertFalse(show(p, {}), 'still muted while the second window is open');
        p.endQuiet(b);
        assertTrue(show(p, {}), 'released once the last window closes');
        assertEq(p.quietCount, 0, 'stack drained');
    });

    test('endQuiet on an unknown token is harmless', () => {
        const p = new NotifyPolicy();
        p.endQuiet(9999);
        assertEq(p.quietCount, 0, 'no spurious entry');
    });

    test('clearQuiet drains the stack', () => {
        const p = new NotifyPolicy();
        p.beginQuiet(QuietScope.ALL);
        p.beginQuiet(QuietScope.SPONTANEOUS);
        p.clearQuiet();
        assertEq(p.quietCount, 0, 'drained');
        assertTrue(show(p, { spontaneous: true }), 'nothing muted after a clear');
    });
});
