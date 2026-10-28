// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// Read-only client for tailscaled's LocalAPI: the HTTP-over-Unix-socket
// interface the `tailscale` CLI itself talks to. `tailscale status --json`
// is nothing but a GET of /localapi/v0/status, printed; asking the socket
// directly gets the same JSON without starting a 30 MB Go program to fetch
// it. That launch used to happen twice per poll, from the compositor's own
// process, and on a laptop running on battery it was enough to drop frames
// every few seconds (issue #9).
//
// Strictly a reader. Every request here is a GET, the same one a read-only
// CLI command would have made (status, prefs, serve config, profiles), or
// the IPN bus. The daemon applies the same rules either way: the profile
// list is its operator's only, the rest is open to any local user.
// Anything that changes state still goes through the CLI and spawn.js, so
// the commands the extension can run, and the privileged ones above all,
// stay listed in one place. And every caller treats a failure here as
// "ask the CLI instead": the socket is a fast path, never the only one.
//
// HTTP/1.0 on purpose: the daemon then answers with a plain body and
// closes the connection behind it, so there is no chunked encoding or
// keep-alive to implement, and a streamed answer (the IPN bus) is simply
// read until the daemon hangs up.
//
// Shared by both processes, like spawn.js: no St/Clutter/Meta/Shell, no
// Gtk/Adw.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Where tailscaled listens on Linux (paths.DefaultTailscaledSocket). Fixed
// rather than configurable, like the CLI name in spawn.js: a daemon
// started with a socket somewhere else is still reached, through the CLI,
// whose packaging knows where it put it.
const SOCKET_PATHS = [
    '/var/run/tailscale/tailscaled.sock',
    '/run/tailscale/tailscaled.sock',
];

// The daemon refuses a request carrying any other Host, or any Origin or
// Referer at all: that is what keeps a web page from reaching the socket
// through a local proxy. This one is what the CLI sends.
const HOST = 'local-tailscaled.sock';

// A daemon that accepts the connection and then never answers would
// otherwise hold the caller's refresh in flight for good, and with it
// every poll after it. The CLI gets the same bound from its own context.
//
// Enforced by the socket itself (Gio.SocketClient's `timeout`, which every
// read and write on the connection inherits), not by a main-loop timer:
// an operation that waits longer fails with TIMED_OUT, and there is no
// source in this module for anyone to track or remove.
const REQUEST_TIMEOUT_SECONDS = 10;

const READ_CHUNK = 64 * 1024;

// Bus messages past this size are not decoded, only reported. A message
// that big is a whole network map (daemons that predate peer patches push
// one on every change), which is news by definition, and decoding a few
// megabytes of JSON on the compositor's thread to learn that would cost
// the very frame drops this module exists to prevent.
const MAX_MESSAGE_BYTES = 64 * 1024;

/**
 * First socket path that exists, or null. A stat, not a connect: whether
 * anyone is listening is the request's to find out.
 *
 * @returns {string|null}
 */
export function socketPath() {
    for (const path of SOCKET_PATHS) {
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return path;
    }
    return null;
}

function _requestBytes(path) {
    return new TextEncoder().encode(
        `GET ${path} HTTP/1.0\r\nHost: ${HOST}\r\n\r\n`);
}

function _connect(socket, cancellable) {
    return new Promise((resolve, reject) => {
        const client = new Gio.SocketClient({ timeout: REQUEST_TIMEOUT_SECONDS });
        client.connect_async(Gio.UnixSocketAddress.new(socket), cancellable,
            (c, res) => {
                try {
                    resolve(c.connect_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function _write(stream, bytes, cancellable) {
    return new Promise((resolve, reject) => {
        const step = (offset) => {
            if (offset >= bytes.length) {
                resolve();
                return;
            }
            stream.write_bytes_async(new GLib.Bytes(bytes.subarray(offset)),
                GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
                    try {
                        step(offset + s.write_bytes_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        };
        step(0);
    });
}

function _readChunk(stream, cancellable) {
    return new Promise((resolve, reject) => {
        stream.read_bytes_async(READ_CHUNK, GLib.PRIORITY_DEFAULT, cancellable,
            (s, res) => {
                try {
                    resolve(s.read_bytes_finish(res).toArray());
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function _concat(chunks, total) {
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
        out.set(c, at);
        at += c.length;
    }
    return out;
}

// Index just past the blank line that ends the response head, or -1.
function _headEnd(buf) {
    for (let i = 3; i < buf.length; i++) {
        if (buf[i] === 0x0a && buf[i - 1] === 0x0d &&
            buf[i - 2] === 0x0a && buf[i - 3] === 0x0d)
            return i + 1;
    }
    return -1;
}

/**
 * Parse an HTTP/1.x status line. Exported for the tests.
 *
 * @param {string} line
 * @returns {number} status code, or 0 when the line is not one
 */
export function parseStatusLine(line) {
    const m = /^HTTP\/\d\.\d\s+(\d{3})\b/.exec(line ?? '');
    return m ? parseInt(m[1], 10) : 0;
}

/**
 * Split a complete HTTP/1.0 response into its status and body. Exported
 * for the tests.
 *
 * @param {Uint8Array} buf
 * @returns {{status: number, body: string}}
 */
export function parseResponse(buf) {
    const end = _headEnd(buf);
    if (end < 0) return { status: 0, body: '' };
    const decoder = new TextDecoder('utf-8');
    const head = decoder.decode(buf.subarray(0, end));
    return {
        status: parseStatusLine(head.split('\r\n', 1)[0]),
        body: decoder.decode(buf.subarray(end)),
    };
}

function _close(conn) {
    // Synchronous on purpose and safe to be: closing a Unix socket does
    // not wait on the peer.
    try {
        conn.close(null);
    } catch {
        // Already closed, or never fully open. Nothing to release either way.
    }
}

/**
 * GET one LocalAPI path and resolve with its status and body. Rejects on
 * any transport failure (no daemon, refused, timed out, cancelled); a
 * non-200 answer resolves, so the caller can tell the two apart.
 *
 * @param {string} socket path from socketPath()
 * @param {string} path e.g. '/localapi/v0/status'
 * @param {Gio.Cancellable|null} [cancellable]
 * @returns {Promise<{status: number, body: string}>}
 */
export async function get(socket, path, cancellable = null) {
    let conn = null;
    try {
        conn = await _connect(socket, cancellable);
        await _write(conn.get_output_stream(), _requestBytes(path),
            cancellable);
        const input = conn.get_input_stream();
        const chunks = [];
        let total = 0;
        for (;;) {
            const chunk = await _readChunk(input, cancellable);
            if (chunk.length === 0) break;
            chunks.push(chunk);
            total += chunk.length;
        }
        return parseResponse(_concat(chunks, total));
    } finally {
        if (conn) _close(conn);
    }
}

/**
 * Split a byte stream into newline-terminated messages, across reads.
 * Exported for the tests.
 *
 * Each complete line goes to onMessage, decoded, or as null when it ran
 * past MAX_MESSAGE_BYTES: such a line is never held in full, only counted
 * until its newline turns up.
 *
 * @param {(text: string|null) => void} onMessage
 * @returns {(chunk: Uint8Array) => void}
 */
export function lineSplitter(onMessage) {
    const decoder = new TextDecoder('utf-8');
    let parts = [];
    let size = 0;
    let oversized = false;
    return (chunk) => {
        let start = 0;
        for (;;) {
            const nl = chunk.indexOf(0x0a, start);
            const piece = chunk.subarray(start, nl < 0 ? chunk.length : nl);
            if (!oversized) {
                size += piece.length;
                if (size > MAX_MESSAGE_BYTES) {
                    oversized = true;
                    parts = [];
                } else if (piece.length > 0) {
                    // Copied: the chunk's buffer is not ours to keep.
                    parts.push(piece.slice());
                }
            }
            if (nl < 0) return;
            if (oversized) {
                onMessage(null);
            } else if (size > 0) {
                onMessage(decoder.decode(_concat(parts, size)));
            }
            parts = [];
            size = 0;
            oversized = false;
            start = nl + 1;
        }
    };
}

/**
 * Hold a streaming GET open (the IPN bus) and hand over what it says, one
 * message per line, which is how the daemon writes them.
 *
 * `onOpen` runs once, when the daemon has answered 200. `onMessage` runs
 * for every message after that, with its text, or null for one too big
 * to be worth decoding (see MAX_MESSAGE_BYTES). `onClose` runs once when the stream ends
 * on its own (refused, non-200, daemon gone), with whether it had ever
 * opened. It does not run after stop(), nor after the caller's own
 * cancellable fired: both are the caller's doing, and it already knows.
 *
 * @param {string} socket
 * @param {string} path
 * @param {Gio.Cancellable|null} cancellable
 * @param {{onOpen?: () => void, onMessage?: (text: string|null) => void,
 *          onClose?: (opened: boolean) => void}} handlers
 * @returns {{stop: () => void}}
 */
export function watch(socket, path, cancellable, handlers) {
    // The stream's own cancellable, so stop() can end this stream alone;
    // the caller's, when it fires, cancels it too. Unhooked in finish().
    const own = new Gio.Cancellable();
    const parentId = cancellable
        ? cancellable.connect(() => own.cancel()) : 0;
    let conn = null;
    let opened = false;
    // Two flags, because the two ways out differ in who must hear about
    // it: stop() is the caller's own doing, the rest is news.
    let stopped = false;
    let done = false;

    // The single exit. Every path ends here, stop() included (its cancel
    // fails whatever read or connect is pending), which is what guarantees
    // the socket is closed even when stop() lands mid-connect.
    const finish = () => {
        if (done) return;
        done = true;
        if (parentId) cancellable.disconnect(parentId);
        if (conn) _close(conn);
        if (!stopped && !cancellable?.is_cancelled())
            handlers.onClose?.(opened);
    };

    (async () => {
        conn = await _connect(socket, own);
        await _write(conn.get_output_stream(), _requestBytes(path), own);
        const input = conn.get_input_stream();

        // Up to the head, the socket's timeout applies as it does to get(),
        // so a daemon that never answers is not mistaken for a daemon with
        // nothing to say.
        let pending = new Uint8Array(0);
        let end = -1;
        while (end < 0) {
            const chunk = await _readChunk(input, own);
            if (chunk.length === 0) return;   // hung up before answering
            pending = _concat([pending, chunk], pending.length + chunk.length);
            end = _headEnd(pending);
        }
        const { status } = parseResponse(pending.subarray(0, end));
        if (status !== 200 || stopped) return;

        // From here on, no timeout: a quiet bus is the normal case.
        conn.get_socket().set_timeout(0);

        opened = true;
        handlers.onOpen?.();
        const split = lineSplitter((text) => {
            if (!stopped) handlers.onMessage?.(text);
        });
        if (end < pending.length) split(pending.subarray(end));

        for (;;) {
            const chunk = await _readChunk(input, own);
            if (chunk.length === 0 || stopped) return;
            split(chunk);
        }
    })().catch(() => {}).finally(finish);

    return {
        stop() {
            if (stopped) return;
            stopped = true;
            own.cancel();
        },
    };
}
