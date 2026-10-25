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

// Stands in for a LocalAPI answer that is a refusal rather than a body.
const REFUSED = Symbol('403');

// A client whose commands never leave the process: _run is the single
// funnel every CLI read goes through, so replacing it both stubs the
// answers and records exactly which commands a refresh asked for. The
// LocalAPI is switched off unless a test hands it answers of its own, or
// a machine running the suite with a live tailscaled would answer from
// the real daemon instead.
function fakeClient({ api = null } = {}) {
    const client = new TailscaleClient({ pollSeconds: 3 });
    client._stopTimer();
    client._startWatch = () => {};
    const apiCalls = [];
    client._localApiJson = (path) => {
        apiCalls.push(path);
        const body = api?.[path];
        if (body === undefined) return Promise.resolve(null);
        if (body === REFUSED) return Promise.resolve({ status: 403 });
        return Promise.resolve({ status: 200, json: body });
    };
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
    return { client, calls, apiCalls };
}

suite('refresh: which commands run', () => {
    test('a full refresh asks all four', () => {
        const { client, calls } = fakeClient();
        settle(client.refresh());
        // Sorted: the four run concurrently, and the three that try the
        // socket first reach the CLI a turn later than the one that does not.
        assertDeepEq([...calls].sort(), [
            'debug prefs', 'funnel status --json', 'status --json', 'switch --list',
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

// The point of issue #9: a daemon that answers on its socket must not cost
// a process per poll. The CLI is only the way in when the socket is not.
suite('refresh: the LocalAPI comes first', () => {
    const API = {
        '/localapi/v0/status': JSON.parse(STATUS),
        '/localapi/v0/prefs': JSON.parse(PREFS),
        '/localapi/v0/serve-config': JSON.parse(FUNNEL),
    };

    test('a light poll answered by the socket starts nothing', () => {
        const { client, calls, apiCalls } = fakeClient({ api: API });
        const snap = settle(client.refresh({ full: false }));
        assertDeepEq(calls, []);
        assertDeepEq(apiCalls, ['/localapi/v0/status', '/localapi/v0/prefs']);
        assertEq(snap.running, true);
        client.destroy();
    });

    const PROFILE = {
        ID: 'abc', Name: 'me@example.com',
        NetworkProfile: { DomainName: 'example.com' },
    };
    const WITH_PROFILES = {
        ...API,
        '/localapi/v0/profiles/current': PROFILE,
        '/localapi/v0/profiles/': [PROFILE],
    };

    test('so does a full one, the profile list included', () => {
        const { client, calls } = fakeClient({ api: WITH_PROFILES });
        const snap = settle(client.refresh());
        assertDeepEq(calls, []);
        assertEq(snap.funnels.length, 1, 'the serve config came off the socket');
        assertDeepEq(snap.accounts, [
            { id: 'abc', tailnet: 'example.com', account: 'me@example.com', current: true },
        ]);
        assertEq(snap.canControl, true);
        client.destroy();
    });

    // The daemon lists profiles to its operator only. Its 403 is what
    // canControl is read from, exactly as the CLI's "Access denied" was.
    test('a refused profile list is no operator, with the last list kept', () => {
        const { client, calls } = fakeClient({ api: WITH_PROFILES });
        settle(client.refresh());
        client._localApiJson = (path) => Promise.resolve(
            path.startsWith('/localapi/v0/profiles/')
                ? { status: 403 }
                : { status: 200, json: WITH_PROFILES[path] });
        const snap = settle(client.refresh());
        assertEq(snap.canControl, false);
        assertEq(snap.accounts.length, 1, 'switching stays reachable');
        assertDeepEq(calls, [], 'the refusal is the answer: no CLI to ask');
        client.destroy();
    });

    test('a profile list the socket cannot give comes from the CLI', () => {
        const { client, calls } = fakeClient({ api: API });
        const snap = settle(client.refresh());
        assertDeepEq(calls, ['switch --list']);
        assertEq(snap.accounts.length, 1);
        client.destroy();
    });

    test('so does a status the daemon answers with an error', () => {
        const { client, calls } = fakeClient({
            api: { ...API, '/localapi/v0/status': REFUSED },
        });
        settle(client.refresh({ full: false }));
        assertDeepEq(calls, ['status --json']);
        client.destroy();
    });

    test('the serve config\'s `null` is no funnels, as from the CLI', () => {
        const { client } = fakeClient({
            api: { ...API, '/localapi/v0/serve-config': null },
        });
        assertDeepEq(settle(client.refresh()).funnels, []);
        client.destroy();
    });

    test('a socket that does not answer falls back to the CLI', () => {
        const { client, calls } = fakeClient();
        settle(client.refresh({ full: false }));
        assertDeepEq(calls, ['status --json', 'debug prefs']);
        client.destroy();
    });
});

suite('timer cadence', () => {
    test('the user\'s interval while nothing else says when to look', () => {
        const { client } = fakeClient();
        assertEq(client._timerSeconds(), 3);
        client.destroy();
    });

    test('a safety net only, while the IPN bus is live', () => {
        const { client } = fakeClient();
        client._watch = { live: true, stop: () => {} };
        assertEq(client._timerSeconds(), 60);
        // A user who asked for less often than that still gets less often.
        client._pollSeconds = 60;
        assertEq(client._timerSeconds(), 60);
        client.destroy();
    });

    test('a subscription not yet answered does not count', () => {
        const { client } = fakeClient();
        client._watch = { live: false, stop: () => {} };
        assertEq(client._timerSeconds(), 3);
        client.destroy();
    });
});

suite('IPN bus activity', () => {
    test('a burst of messages is one refresh', () => {
        const { client, calls } = fakeClient();
        settle(client.refresh());
        calls.length = 0;
        client._busActivity();
        client._busActivity();
        client._busActivity();
        assertTrue(driveUntil(() => client._busSettleId === 0 && !client._inflight),
            'the settle timer ran');
        assertDeepEq(calls, ['status --json', 'debug prefs']);
        client.destroy();
    });

    test('a message landing on a running refresh waits for it', () => {
        const { client, calls } = fakeClient();
        settle(client.refresh());
        calls.length = 0;
        client._inflight = true;
        client._busActivity();
        // Long enough for the settle timer to fire at least once.
        driveUntil(() => false, 600);
        assertDeepEq(calls, [], 'nothing ran on top of the running one');
        client._inflight = false;
        assertTrue(driveUntil(() => calls.length >= 2), 'it ran once that one was done');
        client.destroy();
    });

    test('teardown drops a pending one', () => {
        const { client } = fakeClient();
        client._busActivity();
        assertTrue(client._busSettleId !== 0);
        client.destroy();
        assertEq(client._busSettleId, 0);
    });
});
