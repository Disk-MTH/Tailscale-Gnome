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
import { verticalBox } from '../compat.js';
import { funnelClash, funnelMount } from '../tailscale-parse.js';
import { ICON_COPY, LOCKED_OPACITY, dialogTitle } from './rows.js';

const ICON_TRASH = 'user-trash-symbolic';

// The three kinds of funnel the CLI can publish, in the order the dialog
// offers them: the usual one first.
const KINDS = ['https', 'tcp', 'tls-tcp'];

/**
 * A funnel's ports as "external:internal", the order `docker -p` uses, so
 * the mapping reads the same way here as it does everywhere else.
 *
 * Falls back to the public port alone when the target carries no port of
 * its own: a funnel can serve static text, a file path or a Unix socket
 * rather than proxying a local listener.
 *
 * @param {{httpsPort: number, target: string, handler?: string}} f
 * @returns {string}
 */
export function funnelPorts(f) {
    const t = (f.target || '').trim();
    if ((f.handler && f.handler !== 'proxy') || t.startsWith('/') ||
        t.startsWith('text:') || t.startsWith('unix:'))
        return String(f.httpsPort);
    const m = /^(\d+)$/.exec(t) || /:(\d+)(?:\/\S*)?$/.exec(t);
    return m ? `${f.httpsPort}:${m[1]}` : String(f.httpsPort);
}

/**
 * The public address a funnel serves. 443 is left off an HTTPS one because
 * it is what a browser assumes for https: printing it would make the two
 * identical addresses look like two different ones. A TCP funnel has no
 * scheme to assume a port from, so it is always host:port.
 *
 * @param {{host: string, httpsPort: number, kind?: string, path?: string}} f
 * @returns {string}
 */
function _funnelUrl(f) {
    if (f.kind === 'tcp' || f.kind === 'tls-tcp') return `${f.host}:${f.httpsPort}`;
    const port = f.httpsPort === 443 ? '' : `:${f.httpsPort}`;
    const path = f.path && f.path !== '/' ? f.path : '';
    return `https://${f.host}${port}${path}`;
}

// What a published funnel does with a visitor, for its second line.
function _funnelDetail(f) {
    let text;
    if (f.kind === 'tcp')
        text = _fmt(_('forwards TCP to %s'), f.target);
    else if (f.kind === 'tls-tcp')
        text = _fmt(_('terminates TLS, forwards to %s'), f.target);
    else if (f.handler === 'path')
        text = _fmt(_('serves %s'), f.target);
    else if (f.handler === 'text')
        text = _('serves fixed text');
    else
        text = f.target ? _fmt(_('proxies %s'), f.target) : '';
    if (f.proxyProtocol)
        text = _fmt(_('%s, PROXY protocol v%d'), text, f.proxyProtocol);
    return text;
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
// funnelPorts), whatever the kind of funnel. A port the new funnel would
// collide with is shown greyed: re-publishing over it would silently
// overwrite its serve config, so it has to be removed first. HTTPS mounts
// are the exception the path field exists for: several can share a port
// as long as their paths differ (funnelClash).
export const FunnelsDialog = GObject.registerClass(
    class FunnelsDialog extends ModalDialog.ModalDialog {
        _init({ extension, onAdd, onRemove, onRemoveAll, onCopy }) {
            super._init({ styleClass: 'tailscale-send-dialog' });
            this._onAdd = onAdd;
            this._onRemove = onRemove;
            this._onRemoveAll = onRemoveAll;
            this._onCopy = onCopy;
            this._funnels = [];
            this._ports = [];
            this._selectedPort = null;
            this._portButtons = new Map();
            this._kind = 'https';
            this._kindButtons = new Map();
            this._proxyProtocol = 0;
            this._proxyButtons = new Map();

            this.contentLayout.add_child(
                dialogTitle(extension, _('Manage Funnels')));

            /* ------------------------- published ------------------------- */
            // The list comes first: it is the answer to "what am I exposing
            // to the internet right now", which is the question worth
            // putting at the top of a dialog about Funnel.
            const publishedHeader = new St.BoxLayout({ x_expand: true });
            publishedHeader.add_child(new St.Label({
                style_class: 'tailscale-send-subtitle',
                text: _('Published'),
                x_expand: true,
                y_align: Clutter.ActorAlign.END,
            }));
            // Beside the list it empties rather than among the dialog's own
            // buttons, where it would sit next to Add and read as its
            // opposite. Hidden while there is nothing to remove.
            this._removeAllBtn = new St.Button({
                style_class: 'button tailscale-port-choice',
                label: _('Remove all'),
                y_align: Clutter.ActorAlign.END,
                visible: false,
            });
            this._removeAllBtn.connect('clicked', () => this._onRemoveAll());
            publishedHeader.add_child(this._removeAllBtn);
            this.contentLayout.add_child(publishedHeader);

            const scroll = new St.ScrollView({
                style_class: 'tailscale-file-scroll',
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                overlay_scrollbars: true,
            });
            this._list = verticalBox({
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
            // One line per field, its name on the left: five stacked
            // headings over five fields made the dialog taller than a
            // laptop screen, and the list above is what gave way.
            this.contentLayout.add_child(this._subtitle(_('Publish')));

            this._kindRow = this._choiceRow(
                KINDS.map((k) => [k, {
                    'https': _('HTTPS'),
                    'tcp': _('TCP'),
                    'tls-tcp': _('TCP over TLS'),
                }[k]]),
                this._kindButtons, (k) => this._selectKind(k));
            this.contentLayout.add_child(this._field(_('Type'), this._kindRow));

            // The forms a target can take go in the placeholder: they are
            // what an empty field needs, and once something is typed the
            // CLI's own error says what is wrong with it.
            this._entry = new St.Entry({
                style_class: 'tailscale-port-entry',
                can_focus: true,
                x_expand: true,
            });
            this._entry.clutter_text.connectObject(
                'activate', () => this._commit(), this);
            this.contentLayout.add_child(
                this._field(_('Local target'), this._entry));

            // HTTPS only: --set-path.
            this._pathEntry = new St.Entry({
                style_class: 'tailscale-port-entry',
                hint_text: _('/ (optional)'),
                can_focus: true,
                x_expand: true,
            });
            this._pathEntry.clutter_text.connectObject(
                'activate', () => this._commit(),
                // Which ports are free depends on the path: a second mount
                // can share a port with the first.
                'text-changed', () => this._renderPorts(),
                this);
            this._pathField = this._field(_('Path'), this._pathEntry);
            this.contentLayout.add_child(this._pathField);

            // TCP kinds only: --proxy-protocol.
            this._proxyRow = this._choiceRow(
                [[0, _('Off')], [1, 'v1'], [2, 'v2']],
                this._proxyButtons, (v) => this._selectProxy(v));
            this._proxyField = this._field(_('PROXY protocol'), this._proxyRow);
            this.contentLayout.add_child(this._proxyField);

            this._portRow = new St.BoxLayout({
                style_class: 'tailscale-port-choices',
                x_expand: true,
            });
            this.contentLayout.add_child(
                this._field(_('Public port'), this._portRow));

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

            this._selectKind(this._kind);
            this._selectProxy(this._proxyProtocol);
        }

        _subtitle(text) {
            return new St.Label({ style_class: 'tailscale-send-subtitle', text });
        }

        // A field on one line: its name, then the control.
        _field(label, control) {
            const row = new St.BoxLayout({
                style_class: 'tailscale-funnel-field',
                x_expand: true,
            });
            row.add_child(new St.Label({
                style_class: 'tailscale-funnel-field-label',
                text: label,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.add_child(control);
            return row;
        }

        // A row of mutually exclusive buttons, styled like the port row.
        _choiceRow(choices, buttons, onPick) {
            const row = new St.BoxLayout({
                style_class: 'tailscale-port-choices',
                x_expand: true,
            });
            for (const [value, label] of choices) {
                const btn = new St.Button({
                    style_class: 'button tailscale-port-choice',
                    label,
                    can_focus: true,
                });
                btn.connect('clicked', () => onPick(value));
                row.add_child(btn);
                buttons.set(value, btn);
            }
            return row;
        }

        _markSelected(buttons, value) {
            for (const [v, btn] of buttons) {
                if (v === value)
                    btn.add_style_class_name('tailscale-port-choice-selected');
                else
                    btn.remove_style_class_name('tailscale-port-choice-selected');
            }
        }

        _selectKind(kind) {
            this._kind = kind;
            this._markSelected(this._kindButtons, kind);
            const https = kind === 'https';
            this._entry.hint_text = https
                ? _('Port, URL, unix:/socket, /path or text:…')
                : _('Port, host:port or unix:/socket');
            this._pathField.visible = https;
            this._proxyField.visible = !https;
            this._renderPorts();
        }

        _selectProxy(version) {
            this._proxyProtocol = version;
            this._markSelected(this._proxyButtons, version);
        }

        _spec(port) {
            return {
                kind: this._kind,
                httpsPort: port,
                path: this._kind === 'https' ? this._pathEntry.get_text() : '',
            };
        }

        /**
         * Rebuild from a snapshot. Safe to call on every state change: the
         * form's fields are the only thing the user owns here and they are
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

            this._funnels = snap.funnels ?? [];
            this._ports = snap.funnelPorts ?? [];

            this._list.destroy_all_children();
            if (this._funnels.length === 0) {
                this._list.add_child(new St.Label({
                    style_class: 'tailscale-peer-ip tailscale-send-hint',
                    text: _('Nothing is published yet.'),
                }));
            } else {
                for (const f of this._funnels)
                    this._list.add_child(this._makeRow(f));
            }
            this._removeAllBtn.visible = this._funnels.length > 0;

            this._renderPorts();
        }

        // The port buttons, for the kind and path the form holds right now.
        _renderPorts() {
            if (!this._portRow) return;
            this._portButtons.clear();
            this._portRow.destroy_all_children();
            const taken = (port) => !!funnelClash(this._funnels, this._spec(port));
            for (const port of this._ports) {
                const used = taken(port);
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
                !taken(this._selectedPort);
            const firstFree = this._ports.find((p) => !taken(p));
            this._selectPort(stillFree ? this._selectedPort : firstFree ?? null);

            const full = firstFree === undefined;
            // For HTTPS the way out may be a path rather than a removal:
            // every port can still take a mount it does not have yet.
            this._fullLabel.text = this._kind === 'https'
                ? _('Every public port already serves this path.')
                : _('Every public port is in use. Remove one to publish another.');
            this._fullLabel.visible = full;
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
            const text = verticalBox({
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
            const detail = _funnelDetail(f);
            if (detail) {
                text.add_child(new St.Label({
                    style_class: 'tailscale-peer-ip',
                    text: detail,
                }));
            }
            row.add_child(text);

            const copyBtn = new St.Button({
                style_class: 'button tailscale-icon-btn',
                accessible_name: _('Copy address'),
                child: new St.Icon({ icon_name: ICON_COPY, icon_size: 16 }),
                y_align: Clutter.ActorAlign.CENTER,
            });
            copyBtn.connect('clicked', () => this._onCopy(url));
            row.add_child(copyBtn);

            const removeBtn = new St.Button({
                style_class: 'button tailscale-icon-btn',
                accessible_name: _('Remove funnel'),
                child: new St.Icon({ icon_name: ICON_TRASH, icon_size: 16 }),
                y_align: Clutter.ActorAlign.CENTER,
            });
            removeBtn.connect('clicked', () => this._onRemove(f));
            row.add_child(removeBtn);
            return row;
        }

        _selectPort(port) {
            this._selectedPort = port;
            this._markSelected(this._portButtons, port);
        }

        // The dialog stays up, so nothing here latches: Add can be pressed
        // again as soon as the list has caught up with the last one.
        _commit() {
            if (this._selectedPort === null) return;
            const https = this._kind === 'https';
            this._onAdd({
                kind: this._kind,
                httpsPort: this._selectedPort,
                target: this._entry.get_text(),
                path: https ? funnelMount(this._pathEntry.get_text()) : '',
                proxyProtocol: https ? 0 : this._proxyProtocol,
            });
        }

        // Same ownership note as SendFileDialog.destroy(): the buttons are
        // children of their rows, so clearing the maps is all that is left
        // once the rows are gone.
        destroy() {
            this._portButtons.clear();
            this._kindButtons.clear();
            this._proxyButtons.clear();

            this._list?.destroy();
            this._list = null;
            this._entry?.destroy();
            this._entry = null;
            this._pathEntry?.destroy();
            this._pathEntry = null;
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
