# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added
- Native GNOME notifications, configured from a new Notifications preferences
  page. They stack into a browsable history under a single Tailscale entry,
  capped at a configurable 1–10 entries.
- A second exit-node panel icon, for an exit node that is routing, beside the
  one that already reported an exit node that cannot. It has its own switch
  and its own colour, which defaults to none at all — the icon then takes the
  panel's own ink and follows a light or dark theme without being told to.
- Nine per-category switches controlling which events may notify, plus a
  failures override that lets errors through even when their category is off.
- Clicking the notification for a received Taildrop file reveals it in the
  file manager, selected inside its folder, via
  `org.freedesktop.FileManager1` (falling back to opening the folder when no
  file manager implements it). The message says so — "click to open".

### Fixed
- Switching accounts produced a burst of notifications, one per setting that
  flipped. It now reports once, when the new profile has been applied.
- Turning Funnel on filled the peer list with two dozen `funnel-ingress-node`
  entries. Those are Tailscale's ingress relays, pushed into the netmap only
  so they can reach us; the daemon flags them `ShareeNode` and `tailscale
  status` hides them on that flag. The extension now does the same, which
  also keeps them out of the exit-node and Taildrop target lists.
- Clicking a notification deleted it instead of leaving it in the history.
  GNOME destroys a notification on activation unless it is `resident`, which
  the extension never set, so a click on a passing banner threw away the
  entry the history was meant to keep.
- The Taildrop "file received" message was parsed wrong. The receiver prints
  `wrote <name> as <path> (<n> bytes)`, and the extension took everything
  after "wrote", so the message ended up carrying the byte count the code
  claimed to strip. It also tried to name the sender from a line
  `tailscale file get` never prints — the record behind that command
  (`apitype.WaitingFile`) holds only a name and a size, so no sender was
  ever available and the "from <peer>" half was unreachable.
- Sending as a zip crashed instead of sending: the archive options were
  handed to the Funnel port dialog rather than to the Taildrop one, so the
  send path received `undefined` where it destructured `{ asZip, password }`.

### Changed
- Taildrop and Funnel availability is read from every poll, like every other
  fact about the tailnet, instead of from a cache refreshed at startup, on
  account switches, and by hand. The capability map it comes from is already
  in the `status --json` the extension runs every couple of seconds, so this
  costs nothing and the menu now follows an admin granting or revoking either
  feature within one poll. A flip is reported: "Funnel enabled for this
  tailnet". Switching tailnets flips them too, but that happens inside the
  account-switch quiet window, so only a real admin change reaches the user.
  A daemon that publishes no capability map answers "don't know" rather than
  "no", and nothing is hidden on the strength of a question that could not be
  asked.
- The `shortcut-add-funnel` keybinding says why nothing happens when the
  tailnet forbids Funnel, instead of opening a port dialog that leads to a
  refusal. The menu entry is hidden in that state, but a shortcut fires
  wherever the user is — the same reason `shortcut-send-file` already
  reports it for Taildrop.
- The "Check availability" button is gone from preferences, along with the
  probe that ran whenever the window opened and the one after a settings
  reset. There is nothing left to refresh by hand. The two GSettings keys
  survive as a mirror of the last poll, for the two consumers that cannot see
  a snapshot: the preferences window, which is a separate process, and the
  Taildrop receiver, which is driven from GSettings.
- One Taildrop entry, "Send files", replaces the "Send file" / "Send folder"
  pair, and the `shortcut-send-file` keybinding reaches the same call. Both
  open the send dialog straight away, and the dialog now owns the selection:
  "Add files" and "Add folders" each open the chooser in their own mode and
  append to a table listing every picked item with its size, plus a running
  total. No chooser can produce a mixed selection on its own — the portal's
  `directory` option selects folders *instead of* files, and in that mode
  picking a file returns the folder containing it — so accumulating across
  two trips is what makes files and folders sendable together.
- Send stays inert until the selection holds at least one real file (an
  empty folder does not count) and at least one recipient is ticked.
- "Send as zip" is a real switch rather than a row that ticks, and it pins
  itself on only while a folder is in the selection. While pinned, the switch
  and its label dim: `reactive = false` alone left a locked control looking
  exactly as clickable as a free one, keeping its full accent fill.
- The send dialog's blocks now share one gutter, so headings, row labels and
  the password field line up instead of each sitting at its own indent, and
  the dialog is wider so more of each file name is readable. Rows carry a
  file or folder icon, spell out their full path on hover, and the tally has
  merged into the line that introduces the recipients — "Send 4 items
  (9.8 MB) to:".
- A Taildrop archive is named for the moment it was made
  (`taildrop-20260729-140533.zip`) rather than for the first entry in it.
  The old name made every archive look like that one file, which says
  nothing about the other three and collides on the receiving end, where
  several sends land in the same folder. The success notification names the
  archive too: "Sent 3 files to redmi" described something the recipient
  never receives, under a name they would then have to guess.
- The Taildrop and Funnel dialogs carry the Tailscale mark next to their
  title. Both are raised over whatever the user was doing, and the mark is
  what identifies who is asking.
- The Taildrop send dialog picks recipients instead of firing on the first
  click. Rows toggle, several devices can be ticked at once, and a Send
  button — inert until something is ticked — starts the transfer. When
  zipping, the archive is built once and reused for every recipient.
- The minimum pending duration moved from the General page to the new
  Notifications page. Its key is `min-pending-duration`, renamed from
  `toast-min-spinner` now that the toast it was named for is gone; the
  behaviour is unchanged, but a value set by hand under the old name does not
  carry over.
- Keyboard shortcuts moved from the General page to their own page.
- Adding a funnel is a "+" button on the Funnel row itself, past the
  dropdown arrow, instead of the last entry inside the submenu. It is the
  only thing that row offers which is not about an existing funnel, and it
  now costs one click rather than two.

### Removed
- The toast backend, and with it the choice of how notifications are
  presented. `lib/toast.js`, its OSD stylesheet block, the `notification-mode`
  enum and key, and `toast-duration` are gone; everything now posts as a
  native GNOME notification. One presentation is less code, and it is the one
  that keeps a history, honours a click, and obeys the user's own
  do-not-disturb — none of which a bubble painted over the desktop can do.
- Per-tailnet feature-state persistence. tailscaled already stores exit node,
  Magic DNS, accepted routes, shields, SSH and LAN access per profile and
  restores them on `tailscale switch`; the extension's copy duplicated that and
  could overwrite what the daemon had just restored.
- The per-feature visibility toggles. Hiding a block of the menu was a
  setting nobody used, and supporting it was the extension's last reason to
  write daemon state on its own — turning a feature off used to switch the
  matching tailscale setting off with it. Every block the tailnet allows is
  now always shown, and no daemon write happens unless you ask for one.
  Taildrop and Funnel keep their admin-availability detection: the
  preferences show it as a status rather than a switch, since an ACL is not
  something a checkbox can grant.

## [0.2.1] - 2026-07-14

### Changed — extensions.gnome.org review compliance
- D-Bus interface renamed `fr.diskmth.TailscaleGnome` →
  `org.gnome.Shell.Extensions.TailscaleGnome` (path
  `/org/gnome/Shell/Extensions/TailscaleGnome`). The object is now
  exported on GNOME Shell's own session connection — no bus name is
  owned anymore; clients call through `org.gnome.Shell`. The Nautilus
  scripts were updated accordingly.
- All signal connections in the shell process now go through
  `connectObject()` / `disconnectObject()`. This also fixes a latent
  bug where the toggle's own `clicked` handler id was disconnected
  from the client object instead of the toggle.
- Every main-loop source is now tracked, removed in `disable()` **and**
  cleared before a replacement is armed: the spinner-floor waits (shared
  `ToastManager.withFeedback`), the prefs-window raise delay, the 10 s
  Funnel watchdog (also removed as soon as the command settles), the
  toast reposition idle and the Taildrop receiver restart delay.
  The receiver restart delay only cleared on destroy: a receiver
  respawned while an earlier restart was still pending overwrote the
  source id and orphaned it, so it survived teardown and could spawn a
  `tailscale file get --loop` subprocess after `disable()`. It is now
  cleared through `_clearReceiverRestart()` on both paths.
- Taildrop availability probes (startup, account switch, prefs Check
  button) now read the `https://tailscale.com/cap/file-sharing`
  capability from `tailscale status --json` Self.CapMap instead of
  spawning `tailscale file cp --targets`.
- Removed the `this._destroyed` guard flags. The client relies on its
  `Gio.Cancellable` and source removal; toasts use their live-list
  membership as the dismiss latch.
- Privileged calls are now fully literal argument vectors, per the
  reviewer's requirement that the complete command be readable at
  review time: the `tailscale` program name is hardcoded (resolved by
  pkexec's trusted root PATH; the configurable binary setting is
  deliberately ignored when elevating) and the `sh -c 'logout && set
  --operator'` chain is gone. Logout still costs a single polkit
  prompt: instead of re-granting the operator itself, it leaves that
  to the next login's `--operator` flag, and the menu keeps the Login
  entry reachable while logged out even without operator (the startup
  operator prompt is also skipped in that state). Multi-account users
  keep switching too: the client serves the last known account list
  while the daemon denies `switch --list` (pruned of the profile that
  just logged out), and picking an account then runs a fixed
  `pkexec tailscale switch <id>` — one prompt, after which the target
  profile's own operator pref applies. A one-click "Set operator" row
  also sits at the top of the Account submenu. All privileged commands
  are documented in README under "Privileged operations".
- zenity is no longer used: the Funnel port prompt is an in-shell
  dialog and the Taildrop send flow picks files through the XDG
  Desktop Portal FileChooser (plain D-Bus, no subprocess).
- Deduplicated helpers (`withFeedback`, `fmt`, `gicon`,
  `openAdminPanel`) into shared modules; dropped dead code (spinner
  fallback for pre-49 shells, unused `stdinText` plumbing, unused
  getters) and unnecessary optional chaining / try-catch wrappers.

### Changed — codebase audit (consistency, dead code, redundancy)
- The subprocess runner and the daemon capability lookup are now shared:
  `spawn()`, `hasCapability()` and the `CAP_*` keys live in
  `lib/util.js`, used by both the shell process and the preferences
  process. `prefs.js` no longer carries its own copy of `_spawn` nor a
  duplicated `CAP_FILE_SHARING` that a comment had to keep "in sync by
  hand" — the prefs Check buttons and the startup probe now call the
  same code path.
- Dropped snapshot fields that nothing ever read: `tailnetName` (a
  verbatim duplicate of `accountName`), `prefs` (the whole raw
  `debug prefs` JSON, re-stored on every poll), `version`, `dnsName`,
  `health` and `operatorUser`, plus the unused `acceptingFiles` getter.
  The JSDoc `Snapshot` typedef had drifted from the real object and now
  describes exactly what the client emits.
- `switchAccount()` reuses `_fetchStatus()` / `_fetchPrefs()` instead of
  re-spawning and re-parsing `status --json` and `debug prefs` inline.
- The Taildrop accept toggle no longer drives the receiver twice: the
  menu writes the gsetting and `extension.js` starts/stops the receiver
  from it, which is also what applies the Taildrop feature gate that the
  direct call was bypassing.
- One factory each for the status pill and the online/offline dot;
  `RoutesSubToggle` no longer re-implements `_decorateWithPill`. The dot
  colours moved from an inline hardcoded style into the stylesheet, and
  the unused `.tailscale-indicator-stopped` rule is gone.
- Uniform `catch` style. `catch (_)` shadowed the `_` gettext alias in
  `prefs.js`, so any translated string added inside one of those blocks
  would have crashed; every catch that ignores its error now uses an
  optional binding.

### Added
- Funnel public-port picker: the Add funnel dialog now offers the three
  ports Tailscale allows (443, 8443, 10000 — read from the daemon's
  CapMap, with a hardcoded fallback), greys out ports that already
  carry a funnel, and the client refuses to overwrite an occupied port
  (remove the existing funnel first). Up to three funnels can now run
  side by side from the menu; add/remove toasts name the public port.
- Spontaneous connection-progress toast: when the daemon enters the
  `Starting` state outside of a user-initiated action (typically while
  tailscaled is still establishing the session right after boot or
  login), a sticky spinner toast says the connection is in progress
  and resolves in place to "Tailscale connected" — or to the current
  status wording if the daemon lands elsewhere.
- Confirmation toast in the preferences window whenever the Taildrop
  inbox folder is actually changed (typed, browsed or reset).

### Fixed
- **Critical.** Selecting any exit node (Automatic or a specific peer)
  crashed gnome-shell and logged the user out. Root cause: the persistent
  `_allowLanRow` ToggleRow was destroyed by `PopupMenuBase.removeAll()`
  during the next render, then re-attached as a disposed actor.
  `_renderExitNodes` now builds a fresh ToggleRow each pass.

### Added
- "Admin panel" button in the Quick Settings menu, paired on the same
  row as "Extension settings" at the bottom of the menu. Opens
  `https://login.tailscale.com/admin/machines` via the default browser.
- New `shortcut-open-admin-panel` GSettings key + Shortcuts row in
  preferences (unbound by default).
- Right-side pill accessory on the Peers, Exit node, Tailnet routes
  and Funnel submenus showing the count or current selection at a
  glance, reusing the same `tailscale-status-pill` styling as the
  toggle accessories.

### Changed
- "Approve one in admin console" hint removed from the empty
  exit-nodes case (the user now reaches the admin console via the
  paired button at the bottom of the menu).
- Operator status icon no longer carries the green `success` CSS
  class when set; it now renders in the theme's neutral symbolic
  colour, matching the warning icon's black-and-white look.

### Added
- **Funnel support.** Snapshot now exposes the active funnels parsed from
  `tailscale funnel status --json`. The Quick Settings menu shows a
  read-only "Funnel" submenu (hidden when none are active) listing each
  public URL and the local target it proxies; clicking a row copies the
  URL. The preferences dialog gains a "Funnel" section with a port
  spin-button to add a funnel and a remove button per active entry.
  Wraps `tailscale funnel --bg --https=<port>` and `tailscale funnel
  --https=<port> off`.
- "Operator status" row at the top of the preferences dialog. Shows whether
  `tailscale debug prefs` reports an `OperatorUser`, with a one-click
  copy of the fix command when it's missing.
- "Start Tailscale at boot" toggle in preferences. Calls
  `pkexec systemctl enable/disable --now tailscaled.service`.
- Configurable keyboard shortcuts (all unbound by default):
  connect / disconnect, toggle automatic exit node, open the Tailscale
  menu, copy this device's Tailscale IP. Captured in-place by clicking
  the row in preferences (Backspace to clear).
- Symbolic icons re-rendered from the project's `tailscale.svg` so the
  panel and toggle share the same look as the canonical Tailscale logo.

### Changed
- "Tailnet routes" submenu now appears only when **Accept routes is on**
  AND at least one peer advertises a route. With Accept routes off, the
  whole section is hidden so the menu stays compact.
- "Allow LAN access" moved out of the main toggle list and into the
  Exit node submenu. It only has meaning while an exit node is active,
  so it shows up at the bottom of that submenu, under a separator.
- Toggling Accept DNS / Accept routes / Shields up / SSH server / Allow
  LAN no longer closes the Quick Settings menu. Pick several at once
  in a single open.
- Switching accounts now preserves your connection state. If Tailscale
  was running on the old account, it is brought up again on the new one;
  if it was stopped, it stays stopped. Previously the daemon would
  reuse whatever state the new profile was last left in.
- Preferences dialog reorganized: Operator status, Display (panel
  indicator + toggle subtitle), Funnel, Shortcuts, Advanced (Start at
  boot + poll interval + binary path). The boot toggle moved into
  Advanced because it's a one-time low-frequency setting.
- Operator status row: when set, shows a clean checkmark
  (`object-select-symbolic`) instead of the small `emblem-ok` badge,
  and quotes the user name in the subtitle (`Set to "diskmth"...`).
- Account submenu now uses the tailnet column (the email) as the row
  title for both the collapsed preview and each account row, falling
  back to the account column only when it differs (and showing it as
  the subtitle). Accounts that logged in as a tagged-machine identity
  no longer display their FQDN as the primary label.
- Quick Settings toggle: when "Show subtitle" is off, the title actor
  is repositioned to vertical center so it doesn't keep sitting where
  the subtitle row used to be.
- `switchAccount` now detects `loggedOut` / `NeedsLogin` after the
  switch and dispatches `login()` instead of trying `up`. Silences the
  spurious "Access denied" notification users saw when reconnecting to
  a tailnet whose auth token had expired.
- Removed the "Always visible" panel-indicator option (and the
  `indicator-always-visible` GSettings key). The icon now follows
  `show-indicator` and the running state.
- Dropped the standalone "Service" preferences group; "Start Tailscale
  at boot" now lives at the top of the Advanced section.
- Extension description in `metadata.json` shortened to one sentence.
- README rewritten in plainer style; repository URL updated to
  https://github.com/Disk-MTH/Tailscale-Gnome.

## [0.1.1] - earlier

### Added
- Snapshot now exposes `magicDNSSuffix` and `advertisedRoutes` (computed
  from each peer's `AllowedIPs` minus its own `/32` and `/128`).
- "Accept DNS" toggle shows the MagicDNS suffix as a right-side pill
  (e.g. `hair-acoustic.ts.net`).
- "Accept routes" toggle shows a pill with the count of routes the
  tailnet currently advertises (e.g. `1 advertised`).
- "Tailnet routes" submenu (read-only) at the bottom of the toggle
  section: lists every `cidr / via peer-hostname` pair. Hidden, along
  with its separator, when no peer advertises a route.

### Changed
- Menu order: Peers now appears **before** Exit node, and DNS appears
  **before** Routes inside the toggle block (DNS is the more common
  preference to flip).
- "Tailscale Settings…" entry renamed to "Extension settings".
- Empty exit-node submenu shows a clearer two-line hint:
  *No approved exit nodes / Approve one in the admin console* (the
  daemon's netmap only surfaces *approved* exit nodes).

### Fixed
- Disconnect now actually disconnects: switched the QuickMenuToggle to
  `toggleMode: true` and dispatched on the post-click `this.checked`.
- The Tailscale CLI exits with code 0 even when it printed "Access
  denied: …" on stderr (typically because `OperatorUser` is unset on
  Linux). `_runAndRefresh` now treats that wording as a failure
  regardless of exit code and emits a notification.
- Account submenu showed "No accounts" wrongly when `tailscale switch
  --list` was denied. Now falls back to showing the current tailnet
  (read-only) with a "switching disabled" hint.
- `prefs.js` used the wrong resource path for `ExtensionPreferences`
  (`resource:///org/gnome/shell/extensions/prefs.js`); switched to the
  canonical `resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js`
  so the preferences dialog opens on GNOME 46-50.

## [0.1.0] - 2026-05-10

### Added
- Quick Settings toggle with Tailscale on/off.
- System indicator icon next to Wi-Fi when Tailscale is up.
- Header showing current device, account, and Tailscale IP.
- Exit-node submenu with "auto:any", per-peer selection, "None" option.
- Peers submenu listing online/offline nodes with "Copy IP" action.
- Preferences submenu: Accept routes, Accept DNS, Allow LAN access,
  Shields up, Run SSH server.
- Account submenu: switch between logged-in tailnets, login, logout.
- Refresh entry to force an immediate state poll.
- Preferences dialog (poll interval, indicator visibility, subtitle text).
- Auto-refresh on external CLI changes (configurable polling).
- GSettings schema, Makefile (build / install / pack), MIT license.
