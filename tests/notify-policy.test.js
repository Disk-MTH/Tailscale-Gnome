import { suite, test, assertTrue, assertFalse, assertEq } from './harness.js';
import { Category, CATEGORY_KEY, NotifyPolicy } from '../lib/notify-policy.js';

const show = (policy, opts) => policy.shouldShow({
    category: Category.TAILDROP, level: 'info', ...opts,
});

suite('NotifyPolicy', () => {
    test('every category maps to a GSettings key', () => {
        const expected = {
            'connection': 'notify-connection',
            'account': 'notify-account',
            'profile-switch': 'notify-profile-switch',
            'exit-node': 'notify-exit-node',
            'network': 'notify-network',
            'taildrop': 'notify-taildrop',
            'funnel': 'notify-funnel',
            'errors': 'notify-errors',
            'misc': 'notify-misc',
        };

        const seenKeys = new Set();
        for (const category of Object.values(Category)) {
            const key = CATEGORY_KEY[category];
            assertEq(key, expected[category], `${category} maps to correct key`);
            assertFalse(seenKeys.has(key), `${key} is unique (not shared with another category)`);
            seenKeys.add(key);
        }
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

    test('a quiet window mutes only spontaneous notifications', () => {
        const p = new NotifyPolicy();
        p.beginQuiet();
        assertFalse(show(p, { spontaneous: true }), 'spontaneous is muted');
        assertTrue(show(p, { spontaneous: false }), 'user action still passes');
    });

    // What `force` used to guarantee, now carried by spontaneous: false — and
    // it still stops at the category filter, which is the whole point of an
    // off switch that means it.
    test('a quiet window never overrides the category filter', () => {
        const p = new NotifyPolicy();
        p.beginQuiet();
        p.setCategoryEnabled(Category.TAILDROP, false);
        assertFalse(show(p, { spontaneous: false }), 'a muted category stays muted');
    });

    test('quiet windows nest and release by token', () => {
        const p = new NotifyPolicy();
        const a = p.beginQuiet();
        const b = p.beginQuiet();
        assertEq(p.quietCount, 2, 'two windows open');
        p.endQuiet(a);
        assertFalse(show(p, { spontaneous: true }), 'still muted while the second window is open');
        p.endQuiet(b);
        assertTrue(show(p, { spontaneous: true }), 'released once the last window closes');
        assertEq(p.quietCount, 0, 'stack drained');
    });

    test('endQuiet on an unknown token is harmless', () => {
        const p = new NotifyPolicy();
        p.endQuiet(9999);
        assertEq(p.quietCount, 0, 'no spurious entry');
    });

    test('clearQuiet drains the stack', () => {
        const p = new NotifyPolicy();
        p.beginQuiet();
        p.beginQuiet();
        p.clearQuiet();
        assertEq(p.quietCount, 0, 'drained');
        assertTrue(show(p, { spontaneous: true }), 'nothing muted after a clear');
    });
});
