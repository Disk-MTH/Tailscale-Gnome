// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// The Funnel manager: what this device publishes to the public internet
// right now, and the form that publishes one more. Fed from the outside on
// every snapshot; it holds no funnel state of its own.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { fmt as _fmt } from '../util.js';
import { ICON_COPY, LOCKED_OPACITY, dialogTitle } from './rows.js';

const ICON_TRASH = 'user-trash-symbolic';

/**
 * A funnel's ports as "external:internal", the order `docker -p` uses, so
 * the mapping reads the same way here as it does everywhere else.
 *
 * Falls back to the public port alone when the target carries no port of
 * its own: a funnel can serve static text or a file path rather than
 * proxying a local listener.
 *
 * @param {{httpsPort: number, target: string}} f
 * @returns {string}
 */
export function funnelPorts(f) {
    const m = /:(\d+)\s*$/.exec(f.target || '');
    return m ? `${f.httpsPort}:${m[1]}` : String(f.httpsPort);
}

/**
 * The public address a funnel serves. 443 is left off because it is what a
 * browser assumes for https: printing it would make the two identical
 * addresses look like two different ones.
 *
 * @param {{host: string, httpsPort: number}} f
 * @returns {string}
 */
function _funnelUrl(f) {
    return `https://${f.host}${f.httpsPort === 443 ? '' : `:${f.httpsPort}`}`;
}

// The whole of Funnel in one place: what is published now, and the form
// that publishes one more. Same visual family as SendFileDialog.
//
// It stays open across both actions, which is the point of merging them.
// Removing a funnel from a dialog that then closed would leave the user
// re-opening it for every entry in a list they came here to prune, and
// adding one without seeing it appear gives no answer to "did that work".
// So the dialog holds no state of its own about the funnels: `render()` is
// called from the outside on every snapshot, and the list, the port
// buttons and the Add button are all rebuilt from it.
//
// Tailscale only allows 443/8443/10000 as public ports (snapshot
// funnelPorts). A port that already carries a funnel is shown greyed:
// re-publishing over it would silently overwrite its serve config, so it
// has to be removed first.
export const FunnelsDialog = GObject.registerClass(
    class FunnelsDialog extends ModalDialog.ModalDialog {
        _init({ extension, onAdd, onRemove, onCopy }) {
            super._init({ styleClass: 'tailscale-send-dialog' });
            this._onAdd = onAdd;
            this._onRemove = onRemove;
            this._onCopy = onCopy;
            this._ports = [];
            this._usedPorts = new Set();
            this._selectedPort = null;
            this._portButtons = new Map();

            this.contentLayout.add_child(
                dialogTitle(extension, _('Manage Funnels')));

            /* ------------------------- published ------------------------- */
            // The list comes first: it is the answer to "what am I exposing
            // to the internet right now", which is the question worth
            // putting at the top of a dialog about Funnel.
            this.contentLayout.add_child(new St.Label({
                style_class: 'tailscale-send-subtitle',
                text: _('Published'),
            }));

            const scroll = new St.ScrollView({
                style_class: 'tailscale-file-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true,
            });
            this._list = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'tailscale-send-list',
            });
            scroll.set_child(this._list);
            this.contentLayout.add_child(scroll);

            this.contentLayout.add_child(new St.Widget({
                style_class: 'tailscale-send-separator',
                height: 1,
                x_expand: true,
            }));

            /* ---------------------------- add ---------------------------- */
            this.contentLayout.add_child(new St.Label({
                style_class: 'tailscale-send-subtitle',
                text: _('Publish a local port'),
            }));

            this._entry = new St.Entry({
                style_class: 'tailscale-port-entry',
                text: '3000',
                can_focus: true,
                x_expand: true,
            });
            this._entry.clutter_text.connectObject(
                'activate', () => this._commit(), this);
            this.contentLayout.add_child(this._entry);

            this.contentLayout.add_child(new St.Label({
                style_class: 'tailscale-send-subtitle',
                text: _('Public port'),
            }));
            this._portRow = new St.BoxLayout({
                style_class: 'tailscale-port-choices',
                x_expand: true,
            });
            this.contentLayout.add_child(this._portRow);

            // Only shown once every allowed port is taken, where it stands
            // in for the Add button it explains the death of.
            this._fullLabel = new St.Label({
                style_class: 'tailscale-peer-ip tailscale-send-hint',
                text: _('Every public port is in use. Remove one to publish another.'),
            });
            this._fullLabel.visible = false;
            this.contentLayout.add_child(this._fullLabel);

            this.setButtons([
                {
                    label: _('Close'),
                    action: () => this.close(),
                    key: Clutter.KEY_Escape,
                },
            ]);
            // Kept, like SendFileDialog's Send: render() greys it out once
            // every public port is taken, and Dialog checks
            // `button.reactive` before firing, on the click and on the
            // Return binding that `default: true` installs.
            this._addButton = this.addButton({
                label: _('Add'),
                action: () => this._commit(),
                default: true,
            });
            this.setInitialKeyFocus(this._entry.clutter_text);
        }

        /**
         * Rebuild from a snapshot. Safe to call on every state change: the
         * port entry's text is the only thing the user owns here and it is
         * never touched.
         *
         * @param {{funnels: object[], funnelPorts: number[]}} snap
         */
        render(snap) {
            // Fed from the outside on every snapshot, which can outlive the
            // dialog by one turn of the main loop if it was destroyed rather
            // than closed. The list is released in destroy(); its absence is
            // what says there is nothing left to render into.
            if (!this._list) return;

            const funnels = snap.funnels ?? [];
            this._ports = snap.funnelPorts ?? [];
            this._usedPorts = new Set(funnels.map((f) => f.httpsPort));

            this._list.destroy_all_children();
            if (funnels.length === 0) {
                this._list.add_child(new St.Label({
                    style_class: 'tailscale-peer-ip tailscale-send-hint',
                    text: _('Nothing is published yet.'),
                }));
            } else {
                for (const f of funnels)
                    this._list.add_child(this._makeRow(f));
            }

            this._portButtons.clear();
            this._portRow.destroy_all_children();
            for (const port of this._ports) {
                const used = this._usedPorts.has(port);
                const btn = new St.Button({
                    style_class: 'button tailscale-port-choice',
                    label: String(port),
                    can_focus: !used,
                    reactive: !used,
                });
                if (used)
                    btn.add_style_class_name('tailscale-port-choice-used');
                else
                    btn.connect('clicked', () => this._selectPort(port));
                this._portRow.add_child(btn);
                this._portButtons.set(port, btn);
            }

            // Keep the user's choice across a re-render when it is still
            // free; otherwise fall to the first port that is.
            const stillFree = this._selectedPort !== null &&
                this._ports.includes(this._selectedPort) &&
                !this._usedPorts.has(this._selectedPort);
            const firstFree = this._ports.find((p) => !this._usedPorts.has(p));
            this._selectPort(stillFree ? this._selectedPort : firstFree ?? null);

            const full = firstFree === undefined;
            this._fullLabel.visible = full;
            this._entry.reactive = !full;
            this._entry.can_focus = !full;
            this._entry.opacity = full ? LOCKED_OPACITY : 255;
            this._addButton.reactive = !full;
            this._addButton.can_focus = !full;
            this._addButton.opacity = full ? LOCKED_OPACITY : 255;
        }

        _makeRow(f) {
            const url = _funnelUrl(f);
            const row = new St.BoxLayout({
                style_class: 'tailscale-file-row',
                x_expand: true,
            });
            const text = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            text.add_child(new St.Label({
                style_class: 'tailscale-funnel-url',
                text: url,
            }));
            // Only when there is something to say. The public port is
            // already the tail of the URL above, so restating it would fill
            // the second line with the first line's information.
            if (f.target) {
                text.add_child(new St.Label({
                    style_class: 'tailscale-peer-ip',
                    text: _fmt(_('proxies %s'), f.target),
                }));
            }
            row.add_child(text);

            const copyBtn = new St.Button({
                style_class: 'button tailscale-icon-btn',
                accessible_name: _('Copy address'),
                child: new St.Icon({ icon_name: ICON_COPY, icon_size: 16 }),
                y_align: Clutter.ActorAlign.CENTER,
            });
            copyBtn.connect('clicked', () => this._onCopy?.(url));
            row.add_child(copyBtn);

            const removeBtn = new St.Button({
                style_class: 'button tailscale-icon-btn',
                accessible_name: _('Remove funnel'),
                child: new St.Icon({ icon_name: ICON_TRASH, icon_size: 16 }),
                y_align: Clutter.ActorAlign.CENTER,
            });
            removeBtn.connect('clicked', () => this._onRemove?.(f));
            row.add_child(removeBtn);
            return row;
        }

        _selectPort(port) {
            this._selectedPort = port;
            for (const [p, btn] of this._portButtons) {
                if (p === port)
                    btn.add_style_class_name('tailscale-port-choice-selected');
                else
                    btn.remove_style_class_name('tailscale-port-choice-selected');
            }
        }

        // The dialog stays up, so nothing here latches: Add can be pressed
        // again as soon as the list has caught up with the last one.
        _commit() {
            if (this._selectedPort === null) return;
            this._onAdd?.({
                localText: this._entry.get_text(),
                httpsPort: this._selectedPort,
            });
        }

        // Same ownership note as SendFileDialog.destroy(): the port buttons
        // are children of _portRow, so clearing the map is all that is left
        // once the row is gone.
        destroy() {
            this._portButtons.clear();

            this._list?.destroy();
            this._list = null;
            this._entry?.destroy();
            this._entry = null;
            this._portRow?.destroy();
            this._portRow = null;
            this._fullLabel?.destroy();
            this._fullLabel = null;
            this._addButton?.destroy();
            this._addButton = null;

            super.destroy();
        }
    },
);
