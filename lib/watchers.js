// Snapshot diffing: turns successive TailscaleClient snapshots into
// semantic events (exit node lost, connection established, …).
//
// Two properties are load-bearing. First, no `resource:///org/gnome/shell/…`
// import, so `make test` exercises the rules directly. Second, events carry
// data but never user-facing text — callers map `type` to translated copy —
// which is what keeps the gettext import out of this file.
//
// Lifted out of menu.js, where _maybeToastConnection and
// _maybeToastExitNodeChange had no business living: they render nothing.

import { Category } from './notify-policy.js';

/** Cold-start tracker. Threaded through computeEvents(). */
export const EMPTY_TRACK = Object.freeze({
    backendState:    null,
    pendingConnection: false,
    seeded:          false,
    accountName:     null,
    autoExitNode:    null,
    effectiveNodeId: null,
    exitNodeID:      null,
    nodeOnline:      null,
    nodeOption:      null,
    taildropAvailable: null,
    funnelsAvailable:  null,
});

// An admin can grant or revoke Taildrop and Funnel tailnet-wide, and the
// only sign of it is a block of the menu that has appeared or gone. These
// say so out loud. `null` — the daemon did not publish a capability map —
// is not a flip in either direction, so only a boolean that actually
// changed counts.
const CAPABILITY_EVENTS = [
    ['taildropAvailable', 'taildrop-enabled', 'taildrop-disabled',
        Category.TAILDROP],
    ['funnelsAvailable', 'funnel-enabled', 'funnel-disabled',
        Category.FUNNEL],
];

// A node only counts as "effective" when actually routable: online AND
// still advertising as an exit. The daemon does not clear `ExitNode: true`
// when its picked node goes offline, so a raw ID compare would miss that
// transition — the pill would show "Auto (None)" with no event fired.
function _effectiveId(node) {
    return node && node.online && node.exitNodeOption ? node.id : null;
}

function _nameOf(node) {
    if (!node)
        return null;
    return node.hostname || node.dnsName?.split('.')[0] || null;
}

// An account switch is a report, not background noise: it is the only event
// here that is not spontaneous, because it answers something the user (or
// `tailscale switch`) did.
function _accountEvents(track, snap, out) {
    if (!snap.accountName)
        return;
    // No named account yet: a logged-out or failed-status first snapshot
    // already set `seeded: true` with `accountName: null`, so this is the
    // guard that actually keeps a first login from reading as a switch away
    // from "no account".
    if (!track.accountName)
        return;
    if (snap.accountName === track.accountName)
        return;
    out.push(_event('account-switched', 'success', { name: snap.accountName }, {
        category: Category.PROFILE_SWITCH,
        spontaneous: false,
    }));
}

function _event(type, level, data = {}, over = {}) {
    return {
        type,
        category: type.startsWith('connection-')
            ? Category.CONNECTION
            : Category.EXIT_NODE,
        level,
        spontaneous: true,
        data,
        ...over,
    };
}

function _connectionEvents(track, snap, out) {
    const prev = track.backendState;
    const now = snap.backendState;
    if (prev === now)
        return track.pendingConnection;

    if (now === 'Starting') {
        out.push(_event('connection-starting', 'pending'));
        return true;
    }
    // Only resolve a phase we actually announced; a daemon that reaches
    // Running without passing through Starting was never pending.
    if (!track.pendingConnection)
        return false;

    if (now === 'Running')
        out.push(_event('connection-established', 'success'));
    else
        out.push(_event('connection-ended', 'info', { backendState: now }));
    return false;
}

function _exitNodeEvents(track, snap, out) {
    if (!track.seeded)
        return;

    const curr = snap.currentExitNode;
    const currEff = _effectiveId(curr);
    const name = _nameOf(curr);

    if (track.autoExitNode && snap.autoExitNode) {
        const prevEff = track.effectiveNodeId;
        if (prevEff && !currEff)
            out.push(_event('exit-node-lost', 'warning'));
        else if (!prevEff && currEff)
            out.push(_event('exit-node-acquired', 'info', { name }));
        else if (prevEff && currEff && prevEff !== currEff)
            out.push(_event('exit-node-switched', 'info', { name }));
        return;
    }

    // Pinned mode: only report on the node the user chose, and only while
    // that choice is unchanged. A different exitNodeID means the user just
    // picked something else, which already produced its own feedback.
    if (track.autoExitNode || snap.autoExitNode)
        return;
    if (!track.exitNodeID || track.exitNodeID !== snap.exitNodeID)
        return;
    if (!curr)
        return;

    if (track.nodeOnline !== null) {
        if (track.nodeOnline && !curr.online)
            out.push(_event('exit-node-offline', 'warning', { name }));
        else if (!track.nodeOnline && curr.online)
            out.push(_event('exit-node-online', 'info', { name }));
    }
    if (track.nodeOption !== null) {
        if (track.nodeOption && !curr.exitNodeOption)
            out.push(_event('exit-node-disabled', 'warning', { name }));
        else if (!track.nodeOption && curr.exitNodeOption)
            out.push(_event('exit-node-reenabled', 'info', { name }));
    }
}

function _capabilityEvents(track, snap, out) {
    // Nothing to compare against on a cold start: the first snapshot is the
    // state of the world, not a change to it.
    if (!track.seeded)
        return;
    for (const [field, onType, offType, category] of CAPABILITY_EVENTS) {
        const prev = track[field];
        const curr = snap[field];
        if (typeof prev !== 'boolean' || typeof curr !== 'boolean')
            continue;
        if (prev === curr)
            continue;
        out.push(_event(
            curr ? onType : offType,
            curr ? 'info' : 'warning',
            {},
            { category },
        ));
    }
}

/**
 * @param {object} track previous tracker; EMPTY_TRACK on cold start
 * @param {object} snap  fresh TailscaleClient snapshot
 * @returns {{events: Array<object>, track: object}}
 */
export function computeEvents(track, snap) {
    if (!snap)
        return { events: [], track };

    const events = [];
    _accountEvents(track, snap, events);
    const pendingConnection = _connectionEvents(track, snap, events);
    _exitNodeEvents(track, snap, events);
    _capabilityEvents(track, snap, events);

    const curr = snap.currentExitNode;
    return {
        events,
        track: {
            backendState:      snap.backendState,
            pendingConnection,
            seeded:            true,
            // Keep the last named tailnet: a logged-out snapshot must not
            // make the next login look like a switch.
            accountName:       snap.accountName || track.accountName,
            autoExitNode:      snap.autoExitNode,
            effectiveNodeId:   _effectiveId(curr),
            exitNodeID:        snap.exitNodeID,
            nodeOnline:        curr?.online ?? null,
            nodeOption:        curr?.exitNodeOption ?? null,
            // Same carry-forward the client applies: a snapshot that could
            // not answer must not read as a revocation next time round.
            taildropAvailable: snap.taildropAvailable ?? track.taildropAvailable,
            funnelsAvailable:  snap.funnelsAvailable ?? track.funnelsAvailable,
        },
    };
}

/** Thin stateful wrapper around computeEvents(). */
export class SnapshotWatcher {
    constructor() {
        this._track = EMPTY_TRACK;
    }

    /**
     * @param {object} snap
     * @returns {Array<object>} events produced by this snapshot
     */
    feed(snap) {
        const { events, track } = computeEvents(this._track, snap);
        this._track = track;
        return events;
    }

    reset() {
        this._track = EMPTY_TRACK;
    }
}
