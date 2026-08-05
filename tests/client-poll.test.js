// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// What the poll is allowed to skip, and what it must carry forward when it
// does. The client runs four commands for a full snapshot but only two on
// the timer, because the other two feed rows that cannot be seen while the
// menu is closed. That saving is only free as long as the snapshot keeps
// reporting the last full answer for them, which is what these check.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { suite, test, assertTrue, assertEq, assertDeepEq } from './harness.js';
import { TailscaleClient } from '../lib/tailscale.js';

// refresh() walks PATH before it runs anything and answers from the probe
// alone when the CLI is missing, so these would test nothing on a machine
// without Tailscale. A stub on PATH makes the probe say yes wherever the
// suite runs; it is never executed, because _run is replaced below.
(function stubBinaryOnPath() {
    const dir = GLib.dir_make_tmp('tailscale-gnome-tests-XXXXXX');
    const stub = Gio.File.new_for_path(GLib.build_filenamev([dir, 'tailscale']));
    stub.replace_contents('#!/bin/sh\nexit 1\n', null, false,
        Gio.FileCreateFlags.NONE, null);
    GLib.chmod(stub.get_path(), 0o755);
    GLib.setenv('PATH', `${dir}:${GLib.getenv('PATH')}`, true);
})();

// The harness is synchronous and refresh() is not. Nothing here waits on a
// real child (_run is stubbed), so driving the default main context until
// the promise settles is enough, and keeps the assertions inline.
function settle(promise) {
    let done = false;
    let value = null;
    let failure = null;
    promise.then(
        (v) => { value = v; done = true; },
        (e) => { failure = e; done = true; },
    );
    const ctx = GLib.MainContext.default();
    while (!done) ctx.iteration(true);
    if (failure) throw failure;
    return value;
}

// Same idea for the one thing that cannot be awaited: a GLib timer firing.
// The deadline is a source of its own so the loop always has something to
// wake it, rather than blocking forever on a timer that never came.
function driveUntil(predicate, timeoutMs = 5000) {
    let expired = false;
    const deadlineId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            expired = true;
            return GLib.SOURCE_REMOVE;
        });
    const ctx = GLib.MainContext.default();
    while (!predicate() && !expired) ctx.iteration(true);
    if (!expired) GLib.source_remove(deadlineId);
    return predicate();
}

const STATUS = JSON.stringify({
    BackendState: 'Running',
    Self: {
        DNSName: 'box.tail1234.ts.net.',
        TailscaleIPs: ['100.64.0.1'],
        Online: true,
        CapMap: {},
    },
    Peer: {},
    CurrentTailnet: { Name: 'example.com' },
    User: {},
});
const PREFS = JSON.stringify({
    WantRunning: true, ExitNodeID: '', OperatorUser: 'someone',
});
const SWITCH = 'ID    Tailnet        Account\n' +
               'abc   example.com    me@example.com*\n';
const FUNNEL = JSON.stringify({
    AllowFunnel: { 'box.tail1234.ts.net:443': true },
});

// A client whose commands never leave the process: _run is the single
// funnel every read path goes through, so replacing it both stubs the
// answers and records exactly which commands a refresh asked for.
function fakeClient() {
    const client = new TailscaleClient({ pollSeconds: 3 });
    client._stopTimer();
    const calls = [];
    const ok = (stdout) => ({ ok: true, code: 0, stdout, stderr: '' });
    client._run = (args) => {
        const cmd = args.join(' ');
        calls.push(cmd);
        switch (cmd) {
        case 'status --json':          return ok(STATUS);
        case 'debug prefs':            return ok(PREFS);
        case 'switch --list':          return ok(SWITCH);
        case 'funnel status --json':   return ok(FUNNEL);
        default:                       return { ok: false, code: 1, stdout: '', stderr: '' };
        }
    };
    return { client, calls };
}

suite('refresh: which commands run', () => {
    test('a full refresh asks all four', () => {
        const { client, calls } = fakeClient();
        settle(client.refresh());
        assertDeepEq(calls, [
            'status --json', 'debug prefs', 'switch --list', 'funnel status --json',
        ]);
        client.destroy();
    });

    test('the timer\'s poll asks only the two the panel needs', () => {
        const { client, calls } = fakeClient();
        settle(client.refresh());
        calls.length = 0;
        settle(client.refresh({ full: false }));
        assertDeepEq(calls, ['status --json', 'debug prefs']);
        client.destroy();
    });

    // The saving lives or dies on which of the two the timer calls, and
    // that is a GLib source rather than an argument, so it is worth
    // watching one actually fire: a timer quietly put back on the full
    // refresh would pass every other test in this file.
    test('the timer really arms the light one', () => {
        const { client, calls } = fakeClient();
        settle(client.refresh());          // prime: installed, so 1s cadence
        client._pollSeconds = 1;
        calls.length = 0;
        client._restartTimer();
        assertTrue(driveUntil(() => calls.length >= 2), 'the timer fired');
        assertDeepEq(calls, ['status --json', 'debug prefs']);
        client.destroy();
    });
});

suite('refresh: what the light poll carries forward', () => {
    test('accounts, funnels and canControl survive it', () => {
        const { client } = fakeClient();
        const full = settle(client.refresh());
        assertEq(full.accounts.length, 1, 'the full refresh found the profile');
        assertEq(full.funnels.length, 1, 'the full refresh found the funnel');

        const light = settle(client.refresh({ full: false }));
        assertDeepEq(light.accounts, full.accounts);
        assertDeepEq(light.funnels, full.funnels);
        assertEq(light.canControl, full.canControl);
        assertEq(light.running, full.running);
        client.destroy();
    });

    test('nothing survives the binary going away', () => {
        const { client } = fakeClient();
        settle(client.refresh());
        // What _goMissing() resets. _knownAccounts is deliberately not in
        // here: it is what lets the menu offer switching once a package is
        // installed again.
        client._goMissing();
        assertDeepEq(client._lastFunnels, []);
        assertDeepEq(client._lastAccounts, { accounts: [], denied: false });
        client.destroy();
    });
});

suite('refresh: a full request landing on a running one', () => {
    test('is queued rather than dropped', () => {
        const { client } = fakeClient();
        client._inflight = true;
        settle(client.refresh());
        assertTrue(client._pendingFull, 'the full request was remembered');
        client._inflight = false;
        client.destroy();
    });

    test('a light request is not queued: the running one already covers it', () => {
        const { client } = fakeClient();
        client._inflight = true;
        settle(client.refresh({ full: false }));
        assertEq(client._pendingFull, false);
        client._inflight = false;
        client.destroy();
    });
});
