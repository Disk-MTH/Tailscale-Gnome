// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// The menu's shared widget vocabulary: the rows every submenu is built out
// of, and the small factories they have in common. Nothing here knows what
// Tailscale is: a row takes what to show and what to do when clicked, and
// menu.js decides both.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { fmt as _fmt, gicon as _gicon } from '../util.js';

export const ICON_ACTIVE = 'tailscale-symbolic';

export const ICON_DISABLED = 'tailscale-disabled-symbolic';

// Everything but the Tailscale logo comes from the user's icon theme, so
// the menu matches whatever the rest of their desktop looks like.
export const ICON_COPY = 'edit-copy-symbolic';

// Clutter opacity, 0-255, for a control that is on screen but cannot be
// operated: currently the "Send as zip" switch while a folder pins it on.
export const LOCKED_OPACITY = 115;

// Heading for the in-shell dialogs: the Tailscale mark, then the title.
// Both dialogs are raised over whatever the user was doing, so the mark is
// what says at a glance which extension is asking.
export function dialogTitle(extension, text) {
    const row = new St.BoxLayout({
        style_class: 'tailscale-dialog-heading',
        x_expand: true,
    });
    row.add_child(new St.Icon({
        gicon: _gicon(extension, ICON_ACTIVE),
        icon_size: 20,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    row.add_child(new St.Label({
        style_class: 'tailscale-send-title',
        text,
        y_align: Clutter.ActorAlign.CENTER,
    }));
    return row;
}

// The right-side status pill used by every row that carries one (submenu
// headers, InfoRow, ToggleRow). One factory so they can never drift apart.
function _makePill() {
    return new St.Label({
        style_class: 'tailscale-status-pill',
        y_align: Clutter.ActorAlign.CENTER,
    });
}

// The small online/offline dot. A sized widget rather than a text glyph, so
// its diameter and fill come from the stylesheet and do not depend on which
// font the shell happens to render "●" with.
function _makeStatusDot(online) {
    return new St.Widget({
        style_class: `tailscale-peer-dot ${online ? 'online' : 'offline'}`,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

// Move an existing dot between the two states. The pair is mutually
// exclusive, so the opposite class always comes off first.
function _setStatusDot(dot, online) {
    dot.remove_style_class_name(online ? 'offline' : 'online');
    dot.add_style_class_name(online ? 'online' : 'offline');
}

/**
 * Build the copy control shared by the self row and every peer row.
 *
 * A node worth copying has two identities (its Tailscale IP and its Magic
 * DNS name), and only the user knows which one they are about to paste. So
 * a single target copies straight away, while two or more expand a chooser
 * under the row rather than guessing.
 *
 * `open` and `onToggle` exist because the rows holding this control are
 * torn down and rebuilt on every state change. Without a key the caller
 * can restore, an expanded chooser would silently fold itself away the
 * moment a peer went online somewhere else in the tailnet.
 *
 * @param {{iconName: string, targets: {label: string, value: string}[],
 *          onCopy: (value: string) => void, open?: boolean,
 *          onToggle?: (open: boolean) => void}} opts
 * @returns {{button: St.Button, chooser: St.BoxLayout}}
 */
function _makeCopyControl({ iconName, targets, onCopy, open = false, onToggle }) {
    // x_align END keeps the choices tucked under the button that opened
    // them; the entries stay at their natural width rather than stretching
    // across the row, so they read as a menu and not as two more rows.
    const chooser = new St.BoxLayout({
        vertical: true,
        x_expand: true,
        x_align: Clutter.ActorAlign.END,
        style_class: 'tailscale-copy-chooser',
        visible: false,
    });
    const button = new St.Button({
        style_class: 'button tailscale-icon-btn',
        child: new St.Icon({ icon_name: iconName, icon_size: 16 }),
        y_align: Clutter.ActorAlign.CENTER,
        can_focus: true,
        accessible_name: _('Copy'),
    });

    if (targets.length === 1) {
        const [only] = targets;
        button.connect('clicked', () => onCopy(only.value));
        return { button, chooser };
    }

    for (const target of targets) {
        const choice = new St.Button({
            style_class: 'tailscale-copy-choice',
            label: target.label,
            x_expand: false,
            x_align: Clutter.ActorAlign.END,
            can_focus: true,
        });
        choice.connect('clicked', () => {
            chooser.visible = false;
            onCopy(target.value);
        });
        chooser.add_child(choice);
    }
    chooser.visible = open;
    button.connect('clicked', () => {
        chooser.visible = !chooser.visible;
        onToggle?.(chooser.visible);
    });
    return { button, chooser };
}

/**
 * What is worth copying for a node, most-used first.
 *
 * The Magic DNS name is only offered when Magic DNS is actually on: with it
 * off the name resolves nowhere, so pasting it would hand the user a string
 * that silently fails.
 *
 * @param {{ip: string, name: string, magicDNS: boolean}} opts
 * @returns {{label: string, value: string}[]}
 */
export function copyTargetsFor({ ip, name, magicDNS }) {
    const targets = [];
    if (ip) targets.push({ label: _('Copy IP'), value: ip });
    if (magicDNS && name && name !== ip)
        targets.push({ label: _fmt(_('Copy %s'), name), value: name });
    return targets;
}

// Decorate a PopupSubMenuMenuItem with a right-side pill, inserted between
// the title label and the dropdown arrow. Returns the pill so callers can
// update it later.
export function decorateWithPill(submenuItem) {
    submenuItem.label.x_expand = true;
    submenuItem.label.y_align = Clutter.ActorAlign.CENTER;
    const pill = _makePill();
    pill.visible = false;
    if (submenuItem._triangleBin)
        submenuItem.insert_child_below(pill, submenuItem._triangleBin);
    else submenuItem.add_child(pill);
    return pill;
}

export const InfoRow = GObject.registerClass(
    class InfoRow extends PopupMenu.PopupBaseMenuItem {
        _init(text, accessory = null, opts = {}) {
            super._init({
                reactive: false,
                style_class: opts.styleClass ?? '',
            });
            this._label = new St.Label({
                text,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this._label);
            this._accessory = null;
            if (accessory) this.setAccessory(accessory);
        }
        setText(t) {
            this._label.text = t;
        }
        setAccessory(t) {
            if (!this._accessory) {
                this._accessory = _makePill();
                this.add_child(this._accessory);
            }
            this._accessory.text = t;
        }
        setOnline(online) {
            if (!this._accessory) return;
            this._accessory.remove_style_class_name('online');
            this._accessory.remove_style_class_name('offline');
            this._accessory.add_style_class_name(online ? 'online' : 'offline');
        }

        activate(_event) {
            // No-op: clicking row body must not close the menu.
        }
    },
);

// Checkmark-style toggle row. Override activate() so clicking does NOT emit
// 'activate' and therefore does NOT close the parent QuickSettings panel.
export const ToggleRow = GObject.registerClass(
    class ToggleRow extends PopupMenu.PopupBaseMenuItem {
        _init(text, onActivate) {
            super._init();
            this._label = new St.Label({
                text,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(this._label);
            this._accessory = null;
            this._onActivate = onActivate;
            this._checked = false;
            this.setOrnament(PopupMenu.Ornament.NONE);
        }
        activate(_event) {
            this._onActivate?.(!this._checked);
        }
        setChecked(v) {
            this._checked = !!v;
            this.setOrnament(
                v ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE,
            );
        }
        setSensitive(v) {
            this.reactive = !!v;
            this.can_focus = !!v;
            this._label.opacity = v ? 255 : 128;
            if (this._accessory) this._accessory.opacity = v ? 230 : 128;
        }
        setAccessory(text) {
            if (!text) {
                if (this._accessory) this._accessory.text = '';
                return;
            }
            if (!this._accessory) {
                this._accessory = _makePill();
                this.add_child(this._accessory);
            }
            this._accessory.text = text;
        }
    },
);

// Hybrid toggle + read-only submenu for "Accept routes". Clicking the label
// area toggles the accept-routes pref (no menu close). Clicking the triangle
// independently opens/closes the submenu showing the route list.
export const RoutesSubToggle = GObject.registerClass(
    class RoutesSubToggle extends PopupMenu.PopupSubMenuMenuItem {
        _init(onToggle) {
            super._init(_('Accept routes'), false);
            this._onToggle = onToggle;
            this._checked = false;
            this.setOrnament(PopupMenu.Ornament.NONE);

            // Same right-side pill as the other submenu headers.
            this._pill = decorateWithPill(this);

            // Make the triangle bin intercept clicks independently so clicking
            // the triangle opens the submenu while clicking the label area
            // toggles the setting.
            if (this._triangleBin) {
                this._triangleBin.reactive = true;
                this._triangleBin.track_hover = true;
                this._triangleBin.connectObject('button-press-event', () => {
                    this.menu.toggle();
                    return Clutter.EVENT_STOP;
                }, this);
            }
        }

        // Toggle pref on click; no super.activate() → no 'activate' signal →
        // no menu close. The triangle handler above opens/closes the submenu.
        activate(_event) {
            this._onToggle?.(!this._checked);
        }

        setChecked(v) {
            this._checked = !!v;
            this.setOrnament(
                v ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE,
            );
        }

        setSensitive(v) {
            this.reactive = !!v;
            this.can_focus = !!v;
            this.label.opacity = v ? 255 : 128;
            this._pill.opacity = v ? 230 : 128;
        }

        // Show or hide the triangle (= dropdown affordance). Hide when the
        // route list is empty so the item behaves like a plain ToggleRow.
        setHasRoutes(has) {
            if (this._triangleBin) this._triangleBin.visible = has;
        }

        setPill(text) {
            this._pill.text = text || '';
            this._pill.visible = !!text;
        }
    },
);

// Peer/account/exit-node row. Override activate() so clicking does NOT emit
// 'activate' and therefore does NOT close the parent QuickSettings panel.
export const PeerRow = GObject.registerClass(
    class PeerRow extends PopupMenu.PopupBaseMenuItem {
        _init({
            title, subtitle, online, checked, onClick, styleClass,
            onCopy, copyIconName, copyTargets = [], copyOpen = false,
            onCopyToggle,
        }) {
            super._init({ style_class: styleClass ?? '' });
            this._onClick = onClick;

            // Everything stacks vertically so the copy chooser can unfold
            // directly beneath the row it belongs to.
            const outer = new St.BoxLayout({ vertical: true, x_expand: true });
            const line = new St.BoxLayout({
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const box = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            box.add_child(new St.Label({ text: title }));
            if (subtitle) {
                box.add_child(
                    new St.Label({
                        text: subtitle,
                        style_class: 'tailscale-peer-ip',
                    }),
                );
            }
            line.add_child(box);

            if (online !== undefined) {
                line.add_child(_makeStatusDot(online));
                if (!online)
                    this.add_style_class_name('tailscale-peer-offline');
            }

            if (onCopy && copyTargets.length > 0) {
                const { button, chooser } = _makeCopyControl({
                    iconName: copyIconName,
                    targets: copyTargets,
                    onCopy,
                    open: copyOpen,
                    onToggle: onCopyToggle,
                });
                line.add_child(button);
                outer.add_child(line);
                outer.add_child(chooser);
            } else {
                outer.add_child(line);
            }
            this.add_child(outer);

            this.setOrnament(
                checked ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE,
            );
        }

        activate(_event) {
            this._onClick?.();
        }
    },
);

// This device, rendered exactly like a peer: Magic DNS name on top, IP
// underneath, same copy control. It is a long-lived row rather than one
// rebuilt per render (the toggle keeps a reference for visibility gating),
// so the parts that change are torn down and rebuilt inside update().
export const SelfRow = GObject.registerClass(
    class SelfRow extends PopupMenu.PopupBaseMenuItem {
        _init() {
            // reactive:true on purpose. PopupBaseMenuItem stamps
            // `popup-inactive-menu-item` on non-reactive items, and the
            // shell theme dims everything inside them, which greyed out
            // the device name, its IP and the copy choices alike. Clicking
            // still does nothing: activate() below is a no-op.
            super._init({ reactive: true });

            this._outer = new St.BoxLayout({ vertical: true, x_expand: true });
            this._line = new St.BoxLayout({
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const text = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._title = new St.Label({ text: '' });
            this._subtitle = new St.Label({
                text: '',
                style_class: 'tailscale-peer-ip',
            });
            text.add_child(this._title);
            text.add_child(this._subtitle);
            this._line.add_child(text);

            this._dot = _makeStatusDot(false);
            this._line.add_child(this._dot);

            this._outer.add_child(this._line);
            this.add_child(this._outer);

            this._copyButton = null;
            this._chooser = null;
        }

        /**
         * @param {{title: string, subtitle: string, online: boolean,
         *          copyIconName: string,
         *          copyTargets: {label: string, value: string}[],
         *          onCopy: (value: string) => void}} opts
         */
        update({
            title, subtitle, online, copyIconName, copyTargets, onCopy,
            copyOpen = false, onCopyToggle,
        }) {
            this._title.text = title;
            this._subtitle.text = subtitle;
            this._subtitle.visible = !!subtitle;

            _setStatusDot(this._dot, online);

            // The chooser's contents depend on the current IP and Magic DNS
            // state, so rebuild rather than patch: a stale entry here would
            // copy an address the device no longer has.
            this._copyButton?.destroy();
            this._chooser?.destroy();
            this._copyButton = null;
            this._chooser = null;
            if (copyTargets.length === 0) return;

            const { button, chooser } = _makeCopyControl({
                iconName: copyIconName,
                targets: copyTargets,
                onCopy,
                open: copyOpen,
                onToggle: onCopyToggle,
            });
            this._copyButton = button;
            this._chooser = chooser;
            this._line.add_child(button);
            this._outer.add_child(chooser);
        }

        activate(_event) {
            // No-op: clicking the row body must not close the menu.
        }
    },
);
