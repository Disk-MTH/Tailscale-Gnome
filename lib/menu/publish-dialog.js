// SPDX-FileCopyrightText: 2026 Disk_MTH
// SPDX-License-Identifier: GPL-2.0-or-later

// The Funnel and Serve managers: what this device shares right now, on the
// internet or within the tailnet, and the form that shares one more. One
// dialog for both, because they are one feature to Tailscale: the same
// command shape, the same serve config, told apart by a per-port flag.
// Fed from the outside on every snapshot; it holds no state of its own
// about what is shared.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { fmt as _fmt } from '../util.js';
import { verticalBox } from '../compat.js';
import { funnelMount, serveClash } from '../tailscale-parse.js';
import { ICON_COPY, LOCKED_OPACITY, dialogTitle } from './rows.js';

const ICON_TRASH = 'user-trash-symbolic';

// The kinds each mode offers, in that order: the usual one first. Funnel
// has no plain HTTP, since the internet only reaches it over TLS.
const FUNNEL_KINDS = ['https', 'tcp', 'tls-tcp'];
const SERVE_KINDS = ['https', 'http', 'tcp', 'tls-tcp'];

// Where a Serve port starts for each kind: the port its scheme implies, so
// the URL needs none. TCP has no such port and starts empty.
const SERVE_DEFAULT_PORT = { 'https': 443, 'http': 80, 'tcp': null, 'tls-tcp': null };

const _isWeb = (kind) => kind === 'https' || kind === 'http';

/**
 * An entry's ports as "external:internal", the order `docker -p` uses, so
 * the mapping reads the same way here as it does everywhere else.
 *
 * Falls back to the outer port alone when the target carries no port of
 * its own: an entry can serve static text, a file path or a Unix socket
 * rather than proxying a local listener.
 *
 * @param {{httpsPort: number, target: string, handler?: string}} f
 * @returns {string}
 */
export function entryPorts(f) {
    const t = (f.target || '').trim();
    if ((f.handler && f.handler !== 'proxy') || t.startsWith('/') ||
        t.startsWith('text:') || t.startsWith('unix:'))
        return String(f.httpsPort);
    const m = /^(\d+)$/.exec(t) || /:(\d+)(?:\/\S*)?$/.exec(t);
    return m ? `${f.httpsPort}:${m[1]}` : String(f.httpsPort);
}

/**
 * The address an entry serves. The scheme's own port (443, 80) is left off
 * a web one, because it is what a browser assumes: printing it would make
 * two identical addresses look like two different ones. A TCP entry has no
 * scheme to assume a port from, so it is always host:port.
 *
 * @param {{host: string, httpsPort: number, kind?: string, path?: string}} f
 * @param {string} fallbackHost used when the entry carries no host
 * @returns {string}
 */
function _entryUrl(f, fallbackHost) {
    const host = f.host || fallbackHost || '';
    if (!_isWeb(f.kind ?? 'https')) return `${host}:${f.httpsPort}`;
    const scheme = f.kind === 'http' ? 'http' : 'https';
    const implied = scheme === 'http' ? 80 : 443;
    const port = f.httpsPort === implied ? '' : `:${f.httpsPort}`;
    const path = f.path && f.path !== '/' ? f.path : '';
    return `${scheme}://${host}${port}${path}`;
}

// What an entry does with a visitor, for its second line.
function _entryDetail(f) {
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

// The whole of one feature in one place: what is shared now, and the form
// that shares one more. Same visual family as SendFileDialog.
//
// It stays open across both actions, which is the point of merging them.
// Removing an entry from a dialog that then closed would leave the user
// re-opening it for every entry in a list they came here to prune, and
// adding one without seeing it appear gives no answer to "did that work".
// So the dialog holds no state of its own about the entries: `render()` is
// called from the outside on every snapshot, and the list, the port
// choices and the Add button are all rebuilt from it.
//
// Funnel only allows a fixed set of public ports (snapshot funnelPorts),
// offered as buttons. Serve takes any port, typed in. Either way a port
// the new entry would collide with is refused before it reaches the CLI
// (serveClash), funnels and serves alike: re-publishing over it would
// silently overwrite its serve config, or move it between the internet
// and the tailnet.
export const PublishDialog = GObject.registerClass(
    class PublishDialog extends ModalDialog.ModalDialog {
        /**
         * @param {{extension: object, funnel: boolean,
         *          onAdd: (spec: object) => void,
         *          onRemove: (entry: object) => void,
         *          onRemoveAll: () => void,
         *          onCopy: (text: string) => void}} params
         */
        _init({ extension, funnel, onAdd, onRemove, onRemoveAll, onCopy }) {
            super._init({ styleClass: 'tailscale-send-dialog' });
            this._funnel = !!funnel;
            this._onAdd = onAdd;
            this._onRemove = onRemove;
            this._onRemoveAll = onRemoveAll;
            this._onCopy = onCopy;
            this._entries = [];      // what this dialog lists
            this._everything = [];   // funnels and serves: what can clash
            this._selfHost = '';
            this._httpsAvailable = null;
            this._ports = [];
            this._selectedPort = null;
            this._portButtons = new Map();
            this._kind = 'https';
            this._kindButtons = new Map();
            this._proxyProtocol = 0;
            this._proxyButtons = new Map();
            // Whether the Serve port field holds the user's own number, as
            // opposed to the default a change of kind put there.
            this._portEdited = false;
            this._settingPort = false;

            this.contentLayout.add_child(dialogTitle(extension,
                this._funnel ? _('Manage Funnels') : _('Manage Serve')));

            /* -------------------------- listed --------------------------- */
            // The list comes first: it is the answer to "what am I sharing
            // right now", which is the question worth putting at the top.
            const listHeader = new St.BoxLayout({ x_expand: true });
            listHeader.add_child(new St.Label({
                style_class: 'tailscale-send-subtitle',
                text: this._funnel ? _('Published') : _('Shared in your tailnet'),
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
            listHeader.add_child(this._removeAllBtn);
            this.contentLayout.add_child(listHeader);

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
            // One line per field, its name on the left: stacked headings
            // over every field made the dialog taller than a laptop
            // screen, and the list above is what gave way.
            this.contentLayout.add_child(this._subtitle(
                this._funnel ? _('Publish') : _('Share')));

            const kinds = this._funnel ? FUNNEL_KINDS : SERVE_KINDS;
            this._kindRow = this._choiceRow(
                kinds.map((k) => [k, {
                    'https': _('HTTPS'),
                    'http': _('HTTP'),
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

            // Web kinds only: --set-path.
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

            if (this._funnel) {
                this._portRow = new St.BoxLayout({
                    style_class: 'tailscale-port-choices',
                    x_expand: true,
                });
                this.contentLayout.add_child(
                    this._field(_('Public port'), this._portRow));
            } else {
                this._portEntry = new St.Entry({
                    style_class: 'tailscale-port-entry',
                    hint_text: _('1 to 65535'),
                    can_focus: true,
                    x_expand: true,
                });
                this._portEntry.clutter_text.connectObject(
                    'activate', () => this._commit(),
                    'text-changed', () => {
                        if (!this._settingPort) this._portEdited = true;
                        this._renderPorts();
                    },
                    this);
                this.contentLayout.add_child(
                    this._field(_('Port'), this._portEntry));
            }

            // Why Add is greyed out, when it is; and, for Serve over HTTPS
            // on a tailnet without certificates, what will happen instead.
            this._hint = new St.Label({
                style_class: 'tailscale-peer-ip tailscale-send-hint',
                visible: false,
            });
            this.contentLayout.add_child(this._hint);

            this.setButtons([
                {
                    label: _('Close'),
                    action: () => this.close(),
                    key: Clutter.KEY_Escape,
                },
            ]);
            // Kept, like SendFileDialog's Send: _renderPorts() greys it out
            // while there is nowhere to put a new entry, and Dialog checks
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
            const web = _isWeb(kind);
            this._entry.hint_text = web
                ? _('Port, URL, unix:/socket, /path or text:…')
                : _('Port, host:port or unix:/socket');
            this._pathField.visible = web;
            this._proxyField.visible = !web;
            // A number the user typed is theirs; the default of the kind
            // they left is not, and follows the kind they picked.
            if (this._portEntry && !this._portEdited) {
                const port = SERVE_DEFAULT_PORT[kind];
                this._settingPort = true;
                this._portEntry.set_text(port ? String(port) : '');
                this._settingPort = false;
            }
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
                path: _isWeb(this._kind) ? this._pathEntry.get_text() : '',
                public: this._funnel,
            };
        }

        // The Serve port field, as a port number, or null.
        _typedPort() {
            const text = this._portEntry.get_text().trim();
            if (!/^\d+$/.test(text)) return null;
            const port = parseInt(text, 10);
            return port >= 1 && port <= 65535 ? port : null;
        }

        /**
         * Rebuild from a snapshot. Safe to call on every state change: the
         * form's fields are the only thing the user owns here and they are
         * never touched.
         *
         * @param {{funnels: object[], serves: object[], funnelPorts: number[],
         *          selfDnsName: string|null, httpsAvailable: boolean|null}} snap
         */
        render(snap) {
            // Fed from the outside on every snapshot, which can outlive the
            // dialog by one turn of the main loop if it was destroyed rather
            // than closed. The list is released in destroy(); its absence is
            // what says there is nothing left to render into.
            if (!this._list) return;

            const funnels = snap.funnels ?? [];
            const serves = snap.serves ?? [];
            this._entries = this._funnel ? funnels : serves;
            this._everything = [
                ...funnels.map((e) => ({ ...e, public: true })),
                ...serves.map((e) => ({ ...e, public: false })),
            ];
            this._ports = snap.funnelPorts ?? [];
            this._selfHost = snap.selfDnsName ?? '';
            this._httpsAvailable = snap.httpsAvailable ?? null;

            this._list.destroy_all_children();
            if (this._entries.length === 0) {
                this._list.add_child(new St.Label({
                    style_class: 'tailscale-peer-ip tailscale-send-hint',
                    text: this._funnel
                        ? _('Nothing is published yet.')
                        : _('Nothing is shared yet.'),
                }));
            } else {
                for (const e of this._entries)
                    this._list.add_child(this._makeRow(e));
            }
            this._removeAllBtn.visible = this._entries.length > 0;

            this._renderPorts();
        }

        // What collides with a new entry on `port`: an entry, or null.
        _clash(port) {
            return serveClash(this._everything, this._spec(port));
        }

        _clashText(port, clash) {
            if (!!clash.public !== this._funnel) {
                return clash.public
                    ? _fmt(_('Port %d is published with Funnel.'), port)
                    : _fmt(_('Port %d is shared with Serve.'), port);
            }
            if (_isWeb(this._kind) && _isWeb(clash.kind) && clash.kind === this._kind)
                return _fmt(_('Port %d already serves this path.'), port);
            return _fmt(_('Port %d is already in use.'), port);
        }

        // The port choice, for the kind and path the form holds right now,
        // and with it whether Add can go ahead and why not.
        _renderPorts() {
            if (!this._addButton) return;
            let blocked = null;   // why Add is greyed out, or null

            if (this._funnel) {
                this._portButtons.clear();
                this._portRow.destroy_all_children();
                const taken = (port) => !!this._clash(port);
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

                // Keep the user's choice across a re-render when it is
                // still free; otherwise fall to the first port that is.
                const stillFree = this._selectedPort !== null &&
                    this._ports.includes(this._selectedPort) &&
                    !taken(this._selectedPort);
                const firstFree = this._ports.find((p) => !taken(p));
                this._selectPort(stillFree ? this._selectedPort : firstFree ?? null);
                // For HTTPS the way out may be a path rather than a
                // removal: every port can still take a mount it lacks.
                if (firstFree === undefined) {
                    blocked = this._kind === 'https'
                        ? _('Every public port already serves this path.')
                        : _('Every public port is in use. Remove one to publish another.');
                }
            } else {
                const port = this._typedPort();
                this._selectedPort = port;
                if (port === null) {
                    blocked = _('Enter a port between 1 and 65535.');
                } else {
                    const clash = this._clash(port);
                    if (clash) blocked = this._clashText(port, clash);
                }
            }

            let hint = blocked;
            // Not a refusal: the CLI walks the user through turning
            // certificates on (it prints a link, which the client opens).
            if (!hint && !this._funnel && this._kind === 'https' &&
                this._httpsAvailable === false)
                hint = _('HTTPS certificates are off for this tailnet; Tailscale will offer to turn them on.');
            this._hint.text = hint ?? '';
            this._hint.visible = !!hint;

            const ok = !blocked;
            this._addButton.reactive = ok;
            this._addButton.can_focus = ok;
            this._addButton.opacity = ok ? 255 : LOCKED_OPACITY;
        }

        _makeRow(e) {
            const url = _entryUrl(e, this._selfHost);
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
            // Only when there is something to say. The port is already the
            // tail of the address above, so restating it would fill the
            // second line with the first line's information.
            const detail = _entryDetail(e);
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
                accessible_name: this._funnel ? _('Remove funnel') : _('Stop sharing'),
                child: new St.Icon({ icon_name: ICON_TRASH, icon_size: 16 }),
                y_align: Clutter.ActorAlign.CENTER,
            });
            removeBtn.connect('clicked', () => this._onRemove(e));
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
            if (this._selectedPort === null || !this._addButton.reactive) return;
            const web = _isWeb(this._kind);
            this._onAdd({
                kind: this._kind,
                httpsPort: this._selectedPort,
                target: this._entry.get_text(),
                path: web ? funnelMount(this._pathEntry.get_text()) : '',
                proxyProtocol: web ? 0 : this._proxyProtocol,
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
            this._portEntry?.destroy();
            this._portEntry = null;
            this._portRow?.destroy();
            this._portRow = null;
            this._hint?.destroy();
            this._hint = null;
            this._addButton?.destroy();
            this._addButton = null;

            super.destroy();
        }
    },
);
