// Tailscale GNOME entry point.
// GNOME Shell 46+ (ESM extensions API).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { TailscaleClient } from './lib/tailscale.js';
import { TailscaleIndicator } from './lib/indicator.js';
import { ToastManager } from './lib/toast.js';
import { PerAccountFeatureState } from './lib/per-account.js';

// Keys backed by `as` arrays in the GSettings schema. Each key holds zero or
// one accelerators (e.g. ["<Super>t"]). Empty array = unbound.
const SHORTCUT_KEYS = [
    'shortcut-toggle-tailscale',
    'shortcut-toggle-exit-node',
    'shortcut-show-menu',
    'shortcut-open-admin-panel',
    'shortcut-send-file',
];

const ADMIN_URL = 'https://login.tailscale.com/admin/machines';

// Session-bus interface exposed for the Nautilus right-click scripts so they
// can hand off file paths to the in-shell picker instead of running their own
// (Zenity-based) UI. Kept tiny on purpose: one method, no signals.
const DBUS_NAME = 'fr.diskmth.TailscaleGnome';
const DBUS_PATH = '/fr/diskmth/TailscaleGnome';
const DBUS_XML = `
<node>
  <interface name="fr.diskmth.TailscaleGnome">
    <method name="SendFiles">
      <arg type="as" name="paths" direction="in"/>
    </method>
  </interface>
</node>`;

export default class TailscaleGnomeExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        ToastManager.init(this._settings, { extension: this });

        this._client = new TailscaleClient({
            binary:      this._settings.get_string('tailscale-binary') || 'tailscale',
            pollSeconds: this._settings.get_int('poll-interval'),
            settings:    this._settings,
        });

        this._settingIds = [
            this._settings.connect('changed::poll-interval', () => {
                this._client.setPollSeconds(this._settings.get_int('poll-interval'));
            }),
            this._settings.connect('changed::tailscale-binary', () => {
                this._client.setBinary(
                    this._settings.get_string('tailscale-binary') || 'tailscale',
                );
            }),
        ];

        for (const key of SHORTCUT_KEYS) {
            this._settingIds.push(
                this._settings.connect(`changed::${key}`, () => this._rebindShortcut(key)),
            );
        }

        this._indicator = new TailscaleIndicator({
            extension: this,
            client:    this._client,
        });
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);

        this._boundShortcuts = new Set();
        for (const key of SHORTCUT_KEYS)
            this._rebindShortcut(key);

        this._client.start();

        // Per-tailnet feature-state persistence. Constructed after
        // start() so it can seed itself from the first snapshot the
        // client buffers, and before the availability probe so the
        // probe's writes land in the active slot. The callback turns
        // a bulk apply (multiple feature-* writes) into a single
        // summary toast — the per-feature handlers below check
        // perAccount.isLoadingSlot and stay quiet during the apply.
        this._perAccount = new PerAccountFeatureState(
            this._settings,
            this._client,
            (accountName) => {
                ToastManager.show({
                    level: 'success',
                    message: `${_('Profile preferences applied')} (${accountName})`,
                });
                // Daemon side-effects (drift correction for OFF
                // toggles) are normally driven by handleFeatureToggled,
                // which we suppressed during the apply. Trigger them
                // silently here via ensureFeatureCompliance on the
                // next snapshot.
                this._client.refresh().catch(() => {});
            },
        );

        // One-shot Taildrop/Funnel availability probe at startup, then
        // again whenever the active tailnet changes — admin ACLs differ
        // per tailnet, so the cached availability flags can't be assumed
        // to carry over. Delayed slightly so the initial daemon refresh
        // has time to settle (probeAvailability runs CLI subprocesses
        // that race with the first poll otherwise).
        this._availabilityProbeId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 1, () => {
                this._availabilityProbeId = 0;
                this._client.probeAvailability().catch(() => {});
                return GLib.SOURCE_REMOVE;
            });
        this._lastAccountName = null;
        this._availabilityAccountListener = this._client.connect(
            'state-changed',
            (_c, snap) => {
                const name = snap?.accountName || null;
                if (name === this._lastAccountName) return;
                // Skip the first state-changed (covered by the startup
                // timeout above); only re-probe on a genuine switch.
                if (this._lastAccountName !== null && name)
                    this._client.probeAvailability().catch(() => {});
                this._lastAccountName = name;
            },
        );

        // Restore Taildrop receiver state. The setting is the source of
        // truth across reloads; the receiver subprocess is owned by the
        // client and gets killed on `disable()` via client.destroy().
        // The receiver only runs when BOTH the user-facing accept toggle
        // is on AND the Taildrop feature itself is enabled in prefs.
        const syncTaildrop = () => {
            const featureOn = this._settings.get_boolean('feature-taildrop');
            const acceptOn  = this._settings.get_boolean('taildrop-accept');
            const inbox     = this._settings.get_string('taildrop-inbox');
            this._client.setAcceptFiles(featureOn && acceptOn, inbox);
        };
        syncTaildrop();
        this._settingIds.push(
            this._settings.connect('changed::taildrop-accept',  syncTaildrop),
            this._settings.connect('changed::feature-taildrop', syncTaildrop),
            this._settings.connect('changed::taildrop-inbox', () => {
                // Inbox path changed: bounce the receiver if it's running so
                // the new directory takes effect.
                const featureOn = this._settings.get_boolean('feature-taildrop');
                const acceptOn  = this._settings.get_boolean('taildrop-accept');
                if (featureOn && acceptOn) {
                    this._client.setAcceptFiles(false);
                    this._client.setAcceptFiles(true,
                        this._settings.get_string('taildrop-inbox'));
                }
            }),
        );

        // One-shot startup check: if the operator pref is missing once the
        // first poll has landed, fire a single polkit prompt. We avoid a
        // state-changed handler because logout/login transiently flip
        // canControl=false during the privileged script (the daemon clears
        // the pref before the second `set --operator=$USER` lands), and a
        // listener would race the pkexec child with its own prompt. After
        // startup, the user's own actions (clicking the toggle, the menu
        // "Set operator" button, etc.) handle every re-prompt explicitly.
        this._startupCheckId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 2, () => {
                this._startupCheckId = 0;
                const snap = this._client?.snapshot;
                if (snap && !snap.error && !snap.canControl)
                    this._client.setOperator();
                return GLib.SOURCE_REMOVE;
            },
        );

        /* -------------------- feature enforcement -------------------- */
        // A Feature toggled OFF in prefs must also disable the underlying
        // tailscale setting — hiding the menu UI alone leaves the feature
        // active (e.g. accept-routes still letting traffic through). We
        // also remember the prior state so re-enabling the feature can
        // restore it without forcing the user to re-flip everything.
        //
        // Each entry describes one feature: how to read it from the
        // snapshot, the setter on the client, the GSettings key holding
        // the saved value, and a UI label used in toast messages.
        const FEATURE_META = {
            'feature-exit-nodes': {
                label: _('Exit nodes'),
                savedKey: 'feature-exit-nodes-saved',
                type: 'string',
                snapKey: 'exitNodeID',
                set: (c, v) => c.setExitNode(v),
            },
            'feature-dns': {
                label: _('Magic DNS'),
                savedKey: 'feature-dns-saved',
                type: 'bool',
                snapKey: 'acceptDNS',
                set: (c, v) => c.setAcceptDNS(v),
            },
            'feature-routes': {
                label: _('Subnet routes'),
                savedKey: 'feature-routes-saved',
                type: 'bool',
                snapKey: 'acceptRoutes',
                set: (c, v) => c.setAcceptRoutes(v),
            },
            'feature-shields-up': {
                label: _('Shields up'),
                savedKey: 'feature-shields-up-saved',
                type: 'bool',
                snapKey: 'shieldsUp',
                set: (c, v) => c.setShieldsUp(v),
            },
            'feature-ssh-server': {
                label: _('Tailscale SSH'),
                savedKey: 'feature-ssh-server-saved',
                type: 'bool',
                snapKey: 'runSSH',
                set: (c, v) => c.setRunSSH(v),
            },
        };

        // Run a long-running client call behind a pending → success/error
        // toast. Honours toast-min-spinner so instant operations don't
        // flash. Errors fall back to the underlying client error message.
        const withSpinner = async (pendingMsg, successMsg, fn) => {
            const toast = ToastManager.show({ level: 'pending', message: pendingMsg });
            const startMs = GLib.get_monotonic_time() / 1000;
            try {
                const r = await fn();
                const elapsed = GLib.get_monotonic_time() / 1000 - startMs;
                const wait = Math.max(0, ToastManager.minSpinnerMs - elapsed);
                if (wait > 0) {
                    await new Promise((res) =>
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, wait, () => {
                            res(); return GLib.SOURCE_REMOVE;
                        }));
                }
                const ok = r?.ok !== false;
                toast.update({
                    level: ok ? 'success' : 'error',
                    message: ok ? successMsg : (r?.message || _('Operation failed')),
                });
                return r;
            } catch (e) {
                toast.update({
                    level: 'error',
                    message: String(e?.message ?? e),
                });
                throw e;
            }
        };

        // Drift correction: if the daemon state diverges from a feature
        // pref that's OFF, force the daemon back. Runs on every snapshot
        // (cheap; each branch is gated on "off in prefs but on in snap").
        const ensureFeatureCompliance = () => {
            const snap = this._client?.snapshot;
            if (!snap || !snap.canControl || snap.loggedOut ||
                snap.backendState === 'NeedsLogin' ||
                snap.backendState === 'NoState')
                return;
            const off = (k) => !this._settings.get_boolean(k);
            for (const [key, meta] of Object.entries(FEATURE_META)) {
                if (!off(key)) continue;
                const cur = snap[meta.snapKey];
                if (meta.type === 'bool' && cur) meta.set(this._client, false);
                else if (meta.type === 'string' && cur) meta.set(this._client, '');
            }
            if (off('feature-exit-nodes') && snap.autoExitNode)
                this._client.setExitNode('');
            if (off('feature-funnels') && (snap.funnels?.length || 0) > 0)
                this._client.resetFunnels();
        };

        this._clientSignalIds = [
            this._client.connect('state-changed', ensureFeatureCompliance),
        ];

        // Per-feature handler with toast feedback and state save/restore.
        // The sync "disabled"/"enabled" toast fires immediately; the
        // underlying tailscale CLI call (if needed) runs behind a spinner
        // toast that resolves to success or error in place.
        const handleFeatureToggled = (key) => {
            const meta = FEATURE_META[key];
            if (!meta) return;
            // PerAccountFeatureState is bulk-applying a tailnet slot:
            // skip individual toasts and daemon writes. The callback
            // emits one summary toast and a final refresh that lets
            // ensureFeatureCompliance reconcile the daemon side.
            if (this._perAccount?.isLoadingSlot) return;
            const enabled = this._settings.get_boolean(key);
            const snap = this._client?.snapshot;
            if (!snap || !snap.canControl || snap.loggedOut ||
                snap.backendState === 'NeedsLogin' ||
                snap.backendState === 'NoState') {
                // Daemon not ready: still toast the sync feature flip; the
                // drift-correction pass will reconcile once it's back.
                ToastManager.show({
                    level: 'success',
                    message: `${meta.label}: ${enabled ? _('enabled') : _('disabled')}`,
                });
                return;
            }
            const current = snap[meta.snapKey];

            if (enabled) {
                ToastManager.show({
                    level: 'success',
                    message: `${meta.label}: ${_('enabled')}`,
                });
                const saved = meta.type === 'bool'
                    ? this._settings.get_boolean(meta.savedKey)
                    : this._settings.get_string(meta.savedKey);
                const needRestore = meta.type === 'bool'
                    ? (saved && !current)
                    : (saved && current !== saved);
                if (needRestore) {
                    withSpinner(
                        `${meta.label}: ${_('turning on')}`,
                        `${meta.label}: ${_('on')}`,
                        () => meta.set(this._client, saved),
                    );
                }
            } else {
                // Snapshot the current daemon state before flipping it off
                // so the next re-enable can restore it.
                if (meta.type === 'bool')
                    this._settings.set_boolean(meta.savedKey, !!current);
                else
                    this._settings.set_string(meta.savedKey, current || '');

                ToastManager.show({
                    level: 'success',
                    message: `${meta.label}: ${_('disabled')}`,
                });
                if (current) {
                    const off = meta.type === 'bool' ? false : '';
                    withSpinner(
                        `${meta.label}: ${_('turning off')}`,
                        `${meta.label}: ${_('off')}`,
                        () => meta.set(this._client, off),
                    );
                }
            }
        };

        for (const key of Object.keys(FEATURE_META)) {
            this._settingIds.push(
                this._settings.connect(`changed::${key}`,
                    () => handleFeatureToggled(key)),
            );
        }

        // Taildrop & funnels: no daemon state to save/restore; just toast
        // the feature flip. Funnels still gets its destructive reset via
        // ensureFeatureCompliance when turned off.
        for (const [key, label] of [
            ['feature-taildrop', _('Taildrop')],
            ['feature-funnels',  _('Funnel')],
        ]) {
            this._settingIds.push(
                this._settings.connect(`changed::${key}`, () => {
                    if (this._perAccount?.isLoadingSlot) return;
                    const on = this._settings.get_boolean(key);
                    ToastManager.show({
                        level: 'success',
                        message: `${label}: ${on ? _('enabled') : _('disabled')}`,
                    });
                    ensureFeatureCompliance();
                }),
            );
        }

        this._exportDbus();
    }

    /* ------------------------------- DBus ------------------------------- */

    _exportDbus() {
        try {
            this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(DBUS_XML, {
                SendFiles: (paths) => {
                    const files = (paths || []).filter((p) => p);
                    if (files.length === 0) return;
                    this._indicator?._toggle?._runSendFlow?.(files);
                },
            });
            this._dbusImpl.export(Gio.DBus.session, DBUS_PATH);
            this._dbusOwnerId = Gio.bus_own_name(
                Gio.BusType.SESSION,
                DBUS_NAME,
                Gio.BusNameOwnerFlags.NONE,
                null, null, null,
            );
        } catch (e) {
            // Non-fatal: a name collision (another instance, stale name) just
            // means the Nautilus scripts can't hand off; the shortcut and
            // menu entry still work.
            console.warn(`tailscale-gnome: DBus export failed: ${e.message}`);
        }
    }

    _unexportDbus() {
        if (this._dbusOwnerId) {
            Gio.bus_unown_name(this._dbusOwnerId);
            this._dbusOwnerId = 0;
        }
        if (this._dbusImpl) {
            try { this._dbusImpl.unexport(); } catch (_) {}
            this._dbusImpl = null;
        }
    }

    disable() {
        this._unexportDbus();

        for (const id of this._settingIds ?? [])
            this._settings.disconnect(id);
        this._settingIds = [];

        for (const id of this._clientSignalIds ?? [])
            this._client?.disconnect(id);
        this._clientSignalIds = [];

        if (this._startupCheckId) {
            GLib.source_remove(this._startupCheckId);
            this._startupCheckId = 0;
        }

        if (this._availabilityProbeId) {
            GLib.source_remove(this._availabilityProbeId);
            this._availabilityProbeId = 0;
        }
        if (this._availabilityAccountListener) {
            this._client?.disconnect(this._availabilityAccountListener);
            this._availabilityAccountListener = 0;
        }

        for (const key of this._boundShortcuts ?? [])
            Main.wm.removeKeybinding(key);
        this._boundShortcuts = null;

        this._perAccount?.destroy();
        this._perAccount = null;

        this._indicator?.destroy();
        this._indicator = null;

        this._client?.destroy();
        this._client = null;

        ToastManager.destroy();

        this._settings = null;
    }

    /* ----------------------------- shortcuts ---------------------------- */

    _rebindShortcut(key) {
        if (this._boundShortcuts.has(key)) {
            Main.wm.removeKeybinding(key);
            this._boundShortcuts.delete(key);
        }
        const accels = this._settings.get_strv(key);
        if (!accels.length || !accels[0]) return;

        const handler = this._shortcutHandler(key);
        if (!handler) return;

        Main.wm.addKeybinding(
            key,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            handler,
        );
        this._boundShortcuts.add(key);
    }

    _shortcutHandler(key) {
        switch (key) {
        case 'shortcut-toggle-tailscale':
            return () => {
                const snap = this._client.snapshot;
                const ready =
                    snap.canControl &&
                    !snap.loggedOut &&
                    snap.backendState !== 'NeedsLogin' &&
                    snap.backendState !== 'NoState';
                if (!ready) {
                    if (!snap.canControl) this._client.setOperator();
                    else ToastManager.show({ level: 'info', message: 'Login required' });
                    return;
                }
                const toggle = this._indicator?._toggle;
                if (snap.running) {
                    toggle?._withFeedback(
                        'Disconnecting Tailscale',
                        'Tailscale disconnected',
                        () => this._client.down(),
                    );
                } else {
                    toggle?._withFeedback(
                        'Connecting Tailscale',
                        'Tailscale connected',
                        () => this._client.up(),
                    );
                }
            };
        case 'shortcut-toggle-exit-node':
            return () => {
                const snap = this._client.snapshot;
                const toggle = this._indicator?._toggle;
                if (snap.exitNodeID) {
                    toggle?._withFeedback(
                        'Clearing exit node',
                        'Exit node cleared',
                        () => this._client.setExitNode(''),
                    );
                } else {
                    toggle?._withFeedback(
                        'Selecting an exit node',
                        'Exit node: auto',
                        () => this._client.setExitNode('auto:any'),
                    );
                }
            };
        case 'shortcut-show-menu':
            return () => this._indicator?.openMenu();
        case 'shortcut-open-admin-panel':
            return () => openAdminPanel();
        case 'shortcut-send-file':
            return () => this._indicator?._toggle?._runSendFlow?.();
        default:
            return null;
        }
    }
}

export function openAdminPanel() {
    try {
        Gio.AppInfo.launch_default_for_uri(ADMIN_URL, null);
    } catch (e) {
        ToastManager.show({
            level: 'error',
            message: `Could not open ${ADMIN_URL}`,
        });
    }
}
