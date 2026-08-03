// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

import { suite, test, assertTrue, assertFalse, assertEq } from './harness.js';
import {
    Category, CATEGORY_KEY, NotifyMode, NotifyPolicy,
} from '../lib/notify-policy.js';

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

    test('categories default to reporting everything', () => {
        const p = new NotifyPolicy();
        assertEq(p.categoryMode(Category.TAILDROP), NotifyMode.ALL, 'default mode');
        assertTrue(show(p, {}), 'unconfigured category passes');
    });

    test('an off category is filtered at every level', () => {
        const p = new NotifyPolicy();
        p.setCategoryMode(Category.TAILDROP, NotifyMode.OFF);
        assertFalse(show(p, {}), 'info in a silenced category is dropped');
        assertFalse(show(p, { level: 'error' }), 'so is an error');
        assertFalse(show(p, { level: 'warning' }), 'so is a warning');
    });

    test('an errors-only category keeps its failures', () => {
        const p = new NotifyPolicy();
        p.setCategoryMode(Category.TAILDROP, NotifyMode.ERRORS);
        assertTrue(show(p, { level: 'error' }), 'error passes');
        assertTrue(show(p, { level: 'warning' }), 'warning passes');
        assertFalse(show(p, { level: 'info' }), 'info is dropped');
        assertFalse(show(p, { level: 'success' }), 'success is dropped');
        assertFalse(show(p, { level: 'pending' }), 'pending is dropped');
    });

    // The global "always report failures" override is gone: each category
    // now carries its own, so silencing one cannot un-silence another.
    test('categories no longer lean on each other', () => {
        const p = new NotifyPolicy();
        p.setCategoryMode(Category.TAILDROP, NotifyMode.OFF);
        p.setCategoryMode(Category.ERRORS, NotifyMode.ALL);
        assertFalse(show(p, { level: 'error' }), 'no escape via another category');
        assertTrue(
            p.shouldShow({ category: Category.ERRORS, level: 'error' }),
            'the errors category itself still reports',
        );
    });

    test('an unknown mode falls back to reporting everything', () => {
        const p = new NotifyPolicy();
        p.setCategoryMode(Category.TAILDROP, 'nonsense');
        assertEq(p.categoryMode(Category.TAILDROP), NotifyMode.ALL, 'coerced to all');
        assertTrue(show(p, {}), 'a stale dconf value cannot silence a category');
    });

    test('a quiet window mutes only spontaneous notifications', () => {
        const p = new NotifyPolicy();
        p.beginQuiet();
        assertFalse(show(p, { spontaneous: true }), 'spontaneous is muted');
        assertTrue(show(p, { spontaneous: false }), 'user action still passes');
    });

    // What `force` used to guarantee, now carried by spontaneous: false, and
    // it still stops at the category filter, which is the whole point of an
    // off switch that means it.
    test('a quiet window never overrides the category filter', () => {
        const p = new NotifyPolicy();
        p.beginQuiet();
        p.setCategoryMode(Category.TAILDROP, NotifyMode.OFF);
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
