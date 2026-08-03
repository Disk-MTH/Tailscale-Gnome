// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// Where snapshot-diff events become words.
//
// watchers.js is a pure diff and carries no gettext import by design; this
// is the other half of that split, and the only reason the watcher can be
// exercised outside a Shell session.

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { fmt as _fmt } from './util.js';
import { statusText } from './menu.js';

const COPY = {
    'connection-starting':    () => _('Connecting Tailscale: this may take a moment'),
    'connection-established': () => _('Tailscale connected'),
    // A Starting phase that resolved to anything other than Running: reuse
    // the pill's status vocabulary (Login required / Logged out / Tailscale
    // unavailable / …) off the live snapshot, rather than a single generic
    // string that ignores why it ended.
    'connection-ended':       (_d, snap) => statusText(snap),
    'exit-node-lost':         () => _('Auto exit node lost'),
    'exit-node-acquired':     (d) => _fmt(_('Auto exit node: %s'), d.name),
    'exit-node-switched':     (d) => _fmt(_('Auto exit node switched to %s'), d.name),
    'exit-node-offline':      (d) => _fmt(_('Exit node %s went offline'), d.name),
    'exit-node-online':       (d) => _fmt(_('Exit node %s is back online'), d.name),
    'exit-node-disabled':     (d) => _fmt(_('Exit node %s was disabled'), d.name),
    'exit-node-reenabled':    (d) => _fmt(_('Exit node %s was re-enabled'), d.name),
    'account-switched':       (d) => _fmt(_('Profile applied (%s)'), d.name),
    // Nobody in this session asked for these: the tailnet's ACL moved under
    // us, and the visible effect is a block of the menu appearing or
    // vanishing. A switch between tailnets flips them too, but that runs
    // inside the account-switch quiet window, so only a genuine admin change
    // reaches the user.
    'taildrop-enabled':       () => _('Taildrop enabled for this tailnet'),
    'taildrop-disabled':      () => _('Taildrop disabled for this tailnet'),
    'funnel-enabled':         () => _('Funnel enabled for this tailnet'),
    'funnel-disabled':        () => _('Funnel disabled for this tailnet'),
    // The CLI left or arrived on PATH mid-session. Only a session that
    // watched it happen gets these; see watchers.js.
    'tailscale-missing':      () => _('Tailscale is no longer installed'),
    'tailscale-installed':    () => _('Tailscale is installed: the menu is back'),
};

/**
 * @param {{type: string, data: object}} event one SnapshotWatcher event
 * @param {object} snap the snapshot that produced it
 * @returns {string} translated, user-facing message
 */
export function watcherMessage(event, snap) {
    return COPY[event.type](event.data, snap);
}
