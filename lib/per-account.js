// Per-account feature-state persistence. Watches the client's
// accountName and snapshots the feature-* gsettings to a JSON dict
// keyed by tailnet name so switching accounts restores the previous
// session's toggles instead of bleeding settings across tailnets.

const STATE_KEY = 'feature-state-per-account';

// Schema keys that should follow the active tailnet. Three groups:
//   - user toggles: which features are visible / enabled in the menu.
//   - saved backups: the daemon state captured when a feature toggle
//     was flipped off, used to restore on re-enable. These are
//     daemon-state snapshots so they're inherently per-tailnet.
//   - availability cache: per-tailnet ACL gates the daemon publishes.
const KEYS = Object.freeze([
    'feature-exit-nodes',
    'feature-dns',
    'feature-routes',
    'feature-shields-up',
    'feature-ssh-server',
    'feature-taildrop',
    'feature-funnels',
    'feature-exit-nodes-saved',
    'feature-dns-saved',
    'feature-routes-saved',
    'feature-shields-up-saved',
    'feature-ssh-server-saved',
    'feature-taildrop-available',
    'feature-funnels-available',
]);

export class PerAccountFeatureState {
    /**
     * @param {Gio.Settings} settings
     * @param {TailscaleClient} client  Emits 'state-changed' with the snapshot.
     * @param {{onSlotLoading?: (accountName: string) => void,
     *          onSlotLoaded?: (accountName: string) => void}} [hooks]
     *   onSlotLoading fires before a slot is applied, onSlotLoaded after.
     *   The pair brackets the burst of settings writes and daemon churn a
     *   switch produces, so the caller can mute it and report once.
     */
    constructor(settings, client, hooks = {}) {
        this._settings = settings;
        this._client = client;
        this._onSlotLoading = hooks.onSlotLoading ?? null;
        this._onSlotLoaded = hooks.onSlotLoaded ?? null;
        this._currentAccount = null;
        // Set while we apply a slot to live keys, so the change
        // listeners don't immediately write the value back into the
        // same slot they just read it from. Also doubles as the
        // "skip toasts / daemon side-effects" signal exposed via
        // isLoadingSlot — feature-change listeners in extension.js
        // read it to stay quiet during a bulk apply.
        this._suppressSave = false;

        // Persist any feature-* change to the current account's slot.
        settings.connectObject(
            ...KEYS.flatMap((k) => [
                `changed::${k}`,
                () => this._saveCurrent(),
            ]),
            this,
        );

        // Account switch driver: first observation just loads (no
        // outgoing account); subsequent changes save the outgoing
        // account before swapping.
        client.connectObject(
            'state-changed',
            (_c, snap) => this._onSnapshot(snap),
            this,
        );

        // Seed from whatever the client already has buffered.
        this._onSnapshot(client.snapshot);
    }

    /** True while a slot's keys are being bulk-applied to live settings. */
    get isLoadingSlot() {
        return this._suppressSave;
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._client.disconnectObject(this);
        this._client = null;
        this._settings = null;
    }

    _onSnapshot(snap) {
        // Empty accountName means "no tailnet known yet" (cold start or
        // logged out). Wait until the daemon names one.
        const acc = snap.accountName || null;
        if (!acc) return;
        if (acc === this._currentAccount) return;

        // First observation: just adopt the account name and snapshot
        // the current live values into its slot. No "switch" happened
        // visually, so skip the load-finished callback to avoid a
        // spurious "Profile preferences applied" toast at startup.
        const isFirstObservation = this._currentAccount === null;

        // Genuine account switch: preserve the outgoing slot's live
        // values before overwriting them with the new slot.
        if (!isFirstObservation)
            this._saveCurrent();

        if (!isFirstObservation && this._onSlotLoading)
            this._onSlotLoading(acc);

        this._currentAccount = acc;
        this._loadSlot(acc);

        if (!isFirstObservation && this._onSlotLoaded)
            this._onSlotLoaded(acc);
    }

    _readDict() {
        const raw = this._settings.get_string(STATE_KEY) || '{}';
        try {
            const obj = JSON.parse(raw);
            return obj && typeof obj === 'object' ? obj : {};
        } catch {
            return {};
        }
    }

    _writeDict(dict) {
        this._settings.set_string(STATE_KEY, JSON.stringify(dict));
    }

    _saveCurrent() {
        if (this._suppressSave) return;
        if (!this._currentAccount) return;
        const dict = this._readDict();
        const slot = {};
        for (const k of KEYS) {
            const v = this._settings.get_value(k);
            slot[k] = v.deep_unpack();
        }
        dict[this._currentAccount] = slot;
        this._writeDict(dict);
    }

    _loadSlot(account) {
        const dict = this._readDict();
        const slot = dict[account];
        // No saved state for this account yet: keep current live values
        // as the seed and let the next change write them back.
        if (!slot || typeof slot !== 'object') {
            this._saveCurrent();
            return;
        }
        this._suppressSave = true;
        try {
            for (const k of KEYS) {
                if (!(k in slot)) continue;
                const v = slot[k];
                if (typeof v === 'boolean')
                    this._settings.set_boolean(k, v);
                else if (typeof v === 'string')
                    this._settings.set_string(k, v);
            }
        } finally {
            this._suppressSave = false;
        }
    }
}
