// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// The four sub-menus the toggle rebuilds from every snapshot: routes, exit
// nodes, peers and tailnets. They live here rather than on TailscaleToggle
// so the toggle keeps to wiring the menu together and reacting to the
// client, which is the part a reviewer has to follow to check the cleanup.
//
// Each one is handed the widgets it fills and the callbacks it needs, never
// the toggle itself: the state they read (which copy chooser is unfolded,
// say) stays owned by the toggle, and nothing here reaches into it.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { Notifier, Category } from '../notify.js';
import { fmt as _fmt } from '../util.js';
import {
    ICON_COPY, InfoRow, PeerRow, ToggleRow, copyTargetsFor,
} from './rows.js';

/**
 * How the signed-in account relates to a tailnet, read off the two names
 * the daemon already reports rather than guessed: the API exposes no role
 * field, but the shape of the tailnet name settles it.
 *
 *   - same string as the account  -> the user's own personal tailnet
 *   - another e-mail address      -> someone else's personal tailnet
 *   - a bare domain, no "@"       -> an organisation's tailnet
 *
 * @param {{tailnet: string, account: string}} acc
 * @returns {string} account line for the row, e.g. "me@example.com (Guest)"
 */
function _accountSubtitle(acc) {
    const account = acc.account || '';
    const tailnet = acc.tailnet || '';
    if (!account) return '';
    let kind;
    if (!tailnet || tailnet === account) kind = _('Personal account');
    else if (tailnet.includes('@')) kind = _('Guest account');
    else kind = _('Organisation account');
    return _fmt(_('%s (%s)'), account, kind);
}

export function renderRoutes(toggle, snap) {
    const sub = toggle.menu;
    sub.removeAll();

    // Split off the catch-all routes that an active exit node injects
    // (0.0.0.0/0, ::/0). They aren't subnet routes the user actively
    // accepted via --accept-routes (they ride on the exit-node
    // selection), so listing them inline with real subnets is
    // misleading. Show them under a separate header instead.
    const isDefault = (cidr) => cidr === '0.0.0.0/0' || cidr === '::/0';
    const subnetRoutes = snap.advertisedRoutes.filter(
        (r) => !isDefault(r.cidr),
    );
    const exitDefaults = snap.advertisedRoutes.filter(
        (r) => isDefault(r.cidr),
    );
    const hasAny = subnetRoutes.length + exitDefaults.length > 0;

    toggle.setChecked(snap.acceptRoutes);
    toggle.setSensitive(!!snap.canControl);
    toggle.setHasRoutes(hasAny);

    // Pill counts only meaningful subnet routes: the catch-alls are
    // intentionally excluded.
    if (subnetRoutes.length > 0) {
        toggle.setPill(
            subnetRoutes.length === 1
                ? _('1 route')
                : _fmt(_('%d routes'), subnetRoutes.length),
        );
    } else {
        toggle.setPill('');
    }

    const addPeerRow = (route) => {
        const row = new PeerRow({
            title: route.cidr,
            subtitle: route.peer ? _fmt(_('via %s'), route.peer) : '',
        });
        row.reactive = false;
        sub.addMenuItem(row);
    };

    for (const route of subnetRoutes) addPeerRow(route);

    if (exitDefaults.length > 0) {
        if (subnetRoutes.length > 0)
            sub.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const header = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        header.add_child(new St.Label({
            text: _('Through exit node'),
            style_class: 'tailscale-peer-ip',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        sub.addMenuItem(header);
        for (const route of exitDefaults) addPeerRow(route);
    }
}

export function renderExitNodes({ submenu, pill: pillLabel, client }, snap) {
    const sub = submenu.menu;
    sub.removeAll();

    submenu.label.text = _('Exit node');

    const isAuto = snap.autoExitNode;
    const node = snap.currentExitNode;
    const nameOf = (n) => n.hostname || n.dnsName.split('.')[0] || '';

    // Pill reflects the EFFECTIVE routing state, not just the
    // pref. Three failure modes to surface:
    //   - peer offline (unreachable from the tailnet)
    //   - peer online but stopped advertising itself as exit node
    //   - in auto mode, both of the above
    let pill;
    if (isAuto) {
        if (node && node.online && node.exitNodeOption)
            pill = _fmt(_('Auto (%s)'), nameOf(node));
        else pill = _('Auto (None)');
    } else if (node) {
        const name = nameOf(node);
        if (!node.online) pill = _fmt(_('Offline (%s)'), name);
        else if (!node.exitNodeOption)
            pill = _fmt(_('Disabled (%s)'), name);
        else pill = name;
    } else {
        pill = _('None');
    }
    pillLabel.text = pill;
    pillLabel.visible = true;

    sub.addMenuItem(
        new PeerRow({
            title: _('None'),
            checked: !snap.exitNodeID && !isAuto,
            onClick: () => Notifier.withFeedback(
                Category.EXIT_NODE,
                _('Clearing exit node'),
                _('Exit node cleared'),
                () => client.setExitNode(''),
            ),
        }),
    );
    sub.addMenuItem(
        new PeerRow({
            title: _('Auto'),
            checked: isAuto,
            onClick: () => Notifier.withFeedback(
                Category.EXIT_NODE,
                _('Selecting an exit node'),
                _('Exit node: auto'),
                () => client.setExitNode('auto:any'),
            ),
        }),
    );

    // Render the union of the advertised exit nodes AND the
    // currently-selected peer (so a direct selection sticks in the
    // list with a checkmark even after the peer stops advertising
    // or goes offline). In auto mode we don't mark the auto-picked
    // peer as checked: only the "Auto" row is the user's choice.
    const displayNodes = [...snap.exitNodes];
    if (node && !isAuto && !displayNodes.some((p) => p.id === node.id))
        displayNodes.push(node);

    if (displayNodes.length === 0) {
        const empty = new InfoRow(_('No approved exit nodes'));
        empty.reactive = false;
        sub.addMenuItem(empty);
    } else {
        sub.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        for (const peer of displayNodes) {
            // Use the Tailscale IP for --exit-node: hostnames can contain
            // spaces which the CLI rejects as "invalid value".
            const target = peer.ips[0] || peer.dnsName;
            const isSelected = !isAuto && peer.exitNode;
            const peerName = peer.hostname || peer.dnsName;
            sub.addMenuItem(
                new PeerRow({
                    title: peerName,
                    subtitle: peer.ips[0] ?? '',
                    online: peer.online,
                    checked: isSelected,
                    styleClass: isSelected
                        ? 'tailscale-exit-node-active'
                        : '',
                    onClick: () => Notifier.withFeedback(
                        Category.EXIT_NODE,
                        _fmt(_('Routing through %s'), peerName),
                        _fmt(_('Exit node: %s'), peerName),
                        () => client.setExitNode(target),
                    ),
                }),
            );
        }
    }

    // Allow LAN access only matters when an exit node is active. Build
    // a fresh ToggleRow every render: PopupMenuBase.removeAll() above
    // destroys every existing menu item, so a long-lived field on the
    // toggle would hand us a disposed actor on the next click and
    // crash gnome-shell.
    if (snap.exitNodeID) {
        sub.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const lanRow = new ToggleRow(_('Allow LAN access'), (v) =>
            Notifier.withFeedback(
                Category.NETWORK,
                v ? _('Enabling LAN access') : _('Disabling LAN access'),
                v ? _('LAN access: on') : _('LAN access: off'),
                () => client.setAllowLanAccess(v),
            ),
        );
        lanRow.setChecked(snap.allowLanAccess);
        lanRow.setSensitive(!!snap.canControl);
        sub.addMenuItem(lanRow);
    }
}

export function renderPeers({ submenu, pill, openCopyKey, onCopy, onCopyToggle }, snap) {
    const sub = submenu.menu;
    sub.removeAll();

    const total = snap.peers.length;
    const online = snap.peers.filter((p) => p.online).length;
    submenu.label.text = _('Peers');
    pill.text = total ? `${online}/${total}` : '';
    pill.visible = total > 0;

    if (total === 0) {
        const empty = new InfoRow(_('No peers'));
        empty.reactive = false;
        sub.addMenuItem(empty);
        return;
    }

    for (const peer of snap.peers) {
        const ip = peer.ips[0] ?? '';
        const name = peer.hostname || peer.dnsName.split('.')[0] || '';
        // Survives the rebuild below; dnsName is the only field
        // guaranteed unique across peers.
        const key = peer.dnsName || name;
        sub.addMenuItem(
            new PeerRow({
                title: name || peer.dnsName,
                subtitle: ip
                    ? `${ip} • ${peer.os || ''}`.trim()
                    : peer.os,
                online: peer.online,
                // No onClick: copying is the copy button's job. A
                // whole row that silently copies on contact fires
                // on every stray click, including the ones aimed
                // at scrolling the list.
                onCopy: (value) => onCopy(value),
                copyIconName: ICON_COPY,
                copyTargets: copyTargetsFor({
                    ip,
                    name,
                    magicDNS: snap.acceptDNS,
                }),
                copyOpen: openCopyKey === key,
                onCopyToggle: (open) => {
                    onCopyToggle(open ? key : null);
                },
            }),
        );
    }
}

export function renderAccounts({ submenu, client, closeMenus, makeOperatorRow }, snap) {
    const sub = submenu.menu;
    sub.removeAll();

    // What the user switches between is tailnets, not logins. One
    // account can reach several tailnets (being a guest in someone
    // else's tailnet is the ordinary case), so the tailnet is the
    // identity that distinguishes the profiles, and the account is
    // usually the same string repeated.
    const tailnetTitle = (a) => a.tailnet || a.account || '';

    const currentFromList = snap.accounts.find((a) => a.current);
    const currentLabel =
        tailnetTitle(currentFromList || {}) ||
        snap.accountName ||
        _('No tailnet');
    submenu.label.text = _fmt(
        _('Tailnet: %s'),
        currentLabel,
    );

    // Without operator (typically right after a logout, where the
    // pref went away with the discarded profile) offer the one-click
    // re-grant up front. The account rows below still work in that
    // state (the client elevates the switch itself), so this is a
    // shortcut to full control, not a prerequisite.
    if (!snap.canControl)
        sub.addMenuItem(makeOperatorRow());

    if (snap.accounts.length === 0) {
        if (snap.accountName) {
            const row = new PeerRow({
                title: snap.accountName,
                checked: true,
            });
            row.reactive = false;
            sub.addMenuItem(row);
        }
    } else {
        // Sort alphabetically so the order is stable across refreshes
        // (tailscale switch --list output order is not guaranteed).
        const sorted = [...snap.accounts].sort((a, b) =>
            tailnetTitle(a).localeCompare(tailnetTitle(b)),
        );
        for (const acc of sorted) {
            const label = tailnetTitle(acc);
            sub.addMenuItem(
                new PeerRow({
                    title: label,
                    subtitle: _accountSubtitle(acc),
                    checked: acc.current,
                    onClick: () => {
                        if (acc.current) return;
                        Notifier.withFeedback(
                            Category.PROFILE_SWITCH,
                            _fmt(_('Switching to %s'), label),
                            _fmt(_('Active tailnet: %s'), label),
                            () => client.switchAccount(acc.id),
                        );
                    },
                }),
            );
        }
    }

    sub.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    // Paired Login / Logout buttons on a single row.
    const authRow = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
        style_class: 'tailscale-bottom-row',
    });
    const authBox = new St.BoxLayout({
        x_expand: true,
        style_class: 'tailscale-bottom-buttons',
    });
    authRow.add_child(authBox);

    const loginBtn = new St.Button({
        label: _('Login'),
        x_expand: true,
        style_class: 'button',
    });
    loginBtn.connect('clicked', () => {
        closeMenus();
        Notifier.withFeedback(
            Category.ACCOUNT,
            _('Opening Tailscale login'),
            _('Login flow started'),
            () => client.login(),
        );
    });
    authBox.add_child(loginBtn);

    if (!snap.loggedOut) {
        const logoutBtn = new St.Button({
            label: _('Logout'),
            x_expand: true,
            style_class: 'button',
        });
        logoutBtn.connect('clicked', () => {
            closeMenus();
            Notifier.withFeedback(
                Category.ACCOUNT,
                _('Logging out'),
                _('Logged out'),
                () => client.logout(),
            );
        });
        authBox.add_child(logoutBtn);
    }
    sub.addMenuItem(authRow);
}
