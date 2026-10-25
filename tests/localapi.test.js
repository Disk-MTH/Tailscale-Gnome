// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// The LocalAPI client against a stand-in daemon: a Unix socket in a temp
// directory, answering the way tailscaled answers an HTTP/1.0 request
// (head, blank line, body, hang up). Enough to exercise the transport
// without a Tailscale install, which is the case on every CI runner.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import { suite, test, assertTrue, assertEq } from './harness.js';
import {
    get, watch, lineSplitter, parseResponse, parseStatusLine,
} from '../lib/localapi.js';

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

const enc = new TextEncoder();

// Every chunk is written from a callback of its own: the client reads on
// the same main loop, so a blocking write bigger than the socket buffer
// would wait forever on a reader that cannot run.
function writeAll(stream, bytes, done) {
    if (bytes.length === 0) {
        done();
        return;
    }
    stream.write_bytes_async(new GLib.Bytes(bytes), GLib.PRIORITY_DEFAULT,
        null, (s, res) => {
            const n = s.write_bytes_finish(res);
            writeAll(stream, bytes.subarray(n), done);
        });
}

/**
 * Listen on a fresh socket and hand each connection, once its request head
 * has arrived, to `onRequest(requestText, conn)`.
 */
function fakeDaemon(onRequest) {
    const dir = GLib.dir_make_tmp('tailscale-gnome-localapi-XXXXXX');
    const path = GLib.build_filenamev([dir, 'tailscaled.sock']);
    const service = new Gio.SocketService();
    service.add_address(Gio.UnixSocketAddress.new(path),
        Gio.SocketType.STREAM, Gio.SocketProtocol.DEFAULT, null);
    const held = [];
    const requests = [];
    service.connect('incoming', (_svc, conn) => {
        held.push(conn);
        let text = '';
        const input = conn.get_input_stream();
        const readHead = () => {
            input.read_bytes_async(4096, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                const chunk = s.read_bytes_finish(res).toArray();
                text += new TextDecoder().decode(chunk);
                if (!text.includes('\r\n\r\n') && chunk.length > 0) {
                    readHead();
                    return;
                }
                requests.push(text);
                onRequest(text, conn);
            });
        };
        readHead();
        return true;
    });
    service.start();
    return {
        path,
        requests,
        stop() {
            service.stop();
            service.close();
            for (const c of held) {
                try {
                    c.close(null);
                } catch {}
            }
            GLib.unlink(path);
            GLib.rmdir(dir);
        },
    };
}

function respond(conn, head, body = '', { close = true } = {}) {
    const bytes = enc.encode(`${head}\r\nContent-Type: application/json\r\n\r\n${body}`);
    writeAll(conn.get_output_stream(), bytes, () => {
        if (close) conn.close(null);
    });
}

suite('localapi: parsing', () => {
    test('status lines', () => {
        assertEq(parseStatusLine('HTTP/1.0 200 OK'), 200);
        assertEq(parseStatusLine('HTTP/1.1 403 Forbidden'), 403);
        assertEq(parseStatusLine('garbage'), 0);
        assertEq(parseStatusLine(''), 0);
    });

    test('a response splits at the first blank line', () => {
        const r = parseResponse(enc.encode('HTTP/1.0 200 OK\r\nA: b\r\n\r\n{"x":"\r\n\r\n"}'));
        assertEq(r.status, 200);
        assertEq(r.body, '{"x":"\r\n\r\n"}');
    });

    test('a response cut off inside its head is no response', () => {
        assertEq(parseResponse(enc.encode('HTTP/1.0 200 OK\r\nA: b')).status, 0);
    });
});

suite('localapi: lineSplitter', () => {
    const collect = () => {
        const out = [];
        return { out, feed: lineSplitter((t) => out.push(t)) };
    };

    test('one message per line, across reads', () => {
        const { out, feed } = collect();
        feed(enc.encode('{"a":1}\n{"b"'));
        feed(enc.encode(':2}\n'));
        assertEq(out.length, 2);
        assertEq(out[0], '{"a":1}');
        assertEq(out[1], '{"b":2}');
    });

    test('nothing until the newline', () => {
        const { out, feed } = collect();
        feed(enc.encode('{"a":1}'));
        assertEq(out.length, 0);
    });

    test('blank lines are not messages', () => {
        const { out, feed } = collect();
        feed(enc.encode('\n\n{"a":1}\n\n'));
        assertEq(out.length, 1);
    });

    // A whole network map, from a daemon too old for peer patches.
    test('a huge line is reported, never decoded or held', () => {
        const { out, feed } = collect();
        const big = new Uint8Array(100 * 1024).fill(0x61);
        feed(big.subarray(0, 50 * 1024));
        feed(big.subarray(50 * 1024));
        feed(enc.encode('\n{"a":1}\n'));
        assertEq(out.length, 2);
        assertEq(out[0], null);
        assertEq(out[1], '{"a":1}', 'the next line is read normally');
    });

    test('a character split across reads survives', () => {
        const { out, feed } = collect();
        const bytes = enc.encode('{"n":"é"}\n');
        const at = bytes.indexOf(0xc3) + 1;   // inside the two-byte é
        feed(bytes.subarray(0, at));
        feed(bytes.subarray(at));
        assertEq(out[0], '{"n":"é"}');
    });
});

suite('localapi: get', () => {
    test('sends what the daemon expects, reads the body to the end', () => {
        const d = fakeDaemon((_req, conn) =>
            respond(conn, 'HTTP/1.0 200 OK', '{"BackendState":"Running"}'));
        try {
            const r = settle(get(d.path, '/localapi/v0/status'));
            assertEq(r.status, 200);
            assertEq(JSON.parse(r.body).BackendState, 'Running');
            const req = d.requests[0];
            assertTrue(req.startsWith('GET /localapi/v0/status HTTP/1.0\r\n'), req);
            // Anything else and tailscaled answers 403.
            assertTrue(req.includes('\r\nHost: local-tailscaled.sock\r\n'), req);
            assertTrue(!/origin|referer/i.test(req), req);
        } finally {
            d.stop();
        }
    });

    // A status for a large tailnet runs to hundreds of kilobytes: far past
    // one read, and past the socket buffer too.
    test('a body bigger than one read arrives whole', () => {
        const big = JSON.stringify({ Peer: 'x'.repeat(300 * 1024) });
        const d = fakeDaemon((_req, conn) => respond(conn, 'HTTP/1.0 200 OK', big));
        try {
            const r = settle(get(d.path, '/localapi/v0/status'));
            assertEq(r.body.length, big.length);
        } finally {
            d.stop();
        }
    });

    test('a refusal resolves, with its status', () => {
        const d = fakeDaemon((_req, conn) =>
            respond(conn, 'HTTP/1.0 403 Forbidden', 'profiles access denied\n'));
        try {
            assertEq(settle(get(d.path, '/localapi/v0/profiles/')).status, 403);
        } finally {
            d.stop();
        }
    });

    test('nobody listening rejects', () => {
        let threw = false;
        try {
            settle(get('/nonexistent/tailscaled.sock', '/localapi/v0/status'));
        } catch {
            threw = true;
        }
        assertTrue(threw);
    });

    test('a cancelled request rejects rather than hang', () => {
        // Accepts and never answers.
        const d = fakeDaemon(() => {});
        try {
            const c = new Gio.Cancellable();
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                c.cancel();
                return GLib.SOURCE_REMOVE;
            });
            let threw = false;
            try {
                settle(get(d.path, '/localapi/v0/status', c));
            } catch {
                threw = true;
            }
            assertTrue(threw);
        } finally {
            d.stop();
        }
    });
});

suite('localapi: watch', () => {
    test('open, then one onMessage per line, then onClose', () => {
        let conn = null;
        const d = fakeDaemon((_req, c) => {
            conn = c;
            respond(c, 'HTTP/1.0 200 OK', '', { close: false });
        });
        try {
            let opened = false, closed = null;
            const messages = [];
            const w = watch(d.path, '/localapi/v0/watch-ipn-bus', null, {
                onOpen: () => { opened = true; },
                onMessage: (text) => messages.push(text),
                onClose: (wasOpen) => { closed = wasOpen; },
            });
            assertTrue(driveUntil(() => opened), 'opened');
            assertEq(messages.length, 0, 'an empty bus says nothing');

            writeAll(conn.get_output_stream(),
                enc.encode('{"State":6}\n{"Prefs":{}}\n'), () => {});
            assertTrue(driveUntil(() => messages.length === 2), 'two messages');
            assertEq(messages[0], '{"State":6}');
            assertEq(messages[1], '{"Prefs":{}}');

            conn.close(null);
            assertTrue(driveUntil(() => closed !== null), 'closed');
            assertEq(closed, true);
            w.stop();
        } finally {
            d.stop();
        }
    });

    test('a refused subscription closes without opening', () => {
        const d = fakeDaemon((_req, c) =>
            respond(c, 'HTTP/1.0 400 Bad Request', 'bad mask\n'));
        try {
            let opened = false, closed = null;
            watch(d.path, '/localapi/v0/watch-ipn-bus', null, {
                onOpen: () => { opened = true; },
                onClose: (wasOpen) => { closed = wasOpen; },
            });
            assertTrue(driveUntil(() => closed !== null), 'closed');
            assertEq(closed, false);
            assertEq(opened, false);
        } finally {
            d.stop();
        }
    });

    test('stop() is not reported back as a close', () => {
        const d = fakeDaemon((_req, c) =>
            respond(c, 'HTTP/1.0 200 OK', '', { close: false }));
        try {
            let opened = false, closed = null;
            const w = watch(d.path, '/localapi/v0/watch-ipn-bus', null, {
                onOpen: () => { opened = true; },
                onClose: (wasOpen) => { closed = wasOpen; },
            });
            assertTrue(driveUntil(() => opened), 'opened');
            w.stop();
            driveUntil(() => false, 200);
            assertEq(closed, null);
        } finally {
            d.stop();
        }
    });
});
