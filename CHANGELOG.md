# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.2] - unreleased

### Fixed
- **Set operator**, **Login**, **Logout** and account switching now work on
  distributions that do not keep their tools in `/usr/bin`, NixOS and Guix
  among them. Those four commands are the ones that need root, so they run
  through `pkexec`, which does not inherit the caller's environment: it was
  being given the bare name `tailscale` and resolving it in its own root
  `PATH`, somewhere else than the rest of the extension looks. On NixOS that
  found a different program altogether, and **Set operator** came back with
  `tailscaled does not take non-flag arguments: ["set" "--operator=…"]`.
  The path is now resolved before the command is built, so the elevated half
  of the extension runs the same binary as the unelevated half.

### Changed
- The CLI is looked up in one place for both processes, and the lookup now
  distinguishes what may be run from what may be run *as root*. `$PATH`
  still decides which Tailscale answers the menu, so a per-user install
  keeps working; but a path only becomes an argument to `pkexec` if it sits
  in one of a fixed list of root-owned system directories, read in
  `lib/spawn.js` and settable from nowhere. A Tailscale found outside them
  runs unelevated only, and the four privileged commands say so instead of
  elevating it. See "Privileged operations" in the README.

## [1.0.1] - 2026-08-05

Review feedback from the GNOME Extensions submission of 1.0.0.

### Changed
- The status poll runs two commands instead of four, halving what the Shell
  process spawns: 80 child processes a minute at the default three-second
  interval, down to 40. `switch --list` and `funnel status --json` only ever
  fed rows inside the menu, which cannot be seen while it is closed, and
  neither changes on its own. They now run when the menu opens and after any
  command that could have changed them; the snapshot carries their last
  answer forward in between, so nothing on screen changes. `status --json`
  and `debug prefs` still run at the interval the user picked: the panel
  icon reads from those, and it stays exactly as current as it was.
- Every process the extension starts is now launched from `lib/spawn.js` and
  nowhere else, so the whole set of commands it can run is readable in one
  file. No command, argument or privilege changed.
- The preferences window is opened and left alone. Opening it used to be
  followed by a 120 ms timeout that walked `global.get_window_actors()`,
  matched a window by its title against the extension's name, and called
  `activate()` on it with the current timestamp, to raise a window that was
  already open but buried under the shell. Which window comes up on top is
  the window manager's call, not an extension's, and matching on a title
  string is a guess besides: `openPreferences()` is now the whole of it.
  The toggle no longer carries a raise timeout to arm, re-arm and remove.
- The Help page reads the GNOME Shell version from
  `resource:///org/gnome/Shell/Extensions/js/misc/config.js` instead of
  spawning `gnome-shell --version` and parsing its output. The shell that
  launched the preferences process already published its own version, so
  the row is filled in with the rest of the page rather than arriving late
  and possibly not at all.

## [1.0.0] - 2026-08-03

### Added
- Native GNOME notifications, configured from a new Notifications preferences
  page. They stack into a browsable history under a single Tailscale entry,
  which GNOME itself caps at ten before evicting the oldest.
- A second exit-node panel icon, for an exit node that is routing, beside the
  one that already reported an exit node that cannot. It has its own switch
  and its own colour, which defaults to none at all: the icon then takes the
  panel's own ink and follows a light or dark theme without being told to.
- Nine notification categories, each set to All, Errors or Off independently,
  with a tenth control at the top of the list that applies one answer to all
  of them at once. Errors keeps a category's failures and warnings while
  dropping its successes, which is what the single global failures override
  used to approximate for every category at the same time (badly, since one
  category wanting its errors kept forced them on everywhere).
- A Help page in the preferences, carrying the extension, daemon, operating
  system and GNOME Shell versions (copied to the clipboard in one click)
  beside links to the project's source and its issue tracker.
- Clicking the notification for a received Taildrop file reveals it in the
  file manager, selected inside its folder, via
  `org.freedesktop.FileManager1` (falling back to opening the folder when no
  file manager implements it). The message says so: "click to open".

- A first-class "Tailscale is not installed" state. `Gio.Subprocess.new`
  throws when the program is not on `PATH`, and that rejection used to escape
  the poll: the snapshot never took the error, so the pill read **Disconnected**
  (as if Tailscale were installed and merely off) while every poll raised a
  fresh `Failed to execute child process` banner, one every three seconds for
  the whole session. The client now probes `PATH` before it spawns anything,
  and answers with an empty snapshot flagged `installed: false`. That travels
  on `state-changed` like every other fact, so it is diff-gated: reported once,
  not on repeat.
- Everything that drives a command is off in that state. The menu is stripped
  to a single row naming the missing package; the toggle, the keybindings
  (connect, exit node, admin console) and the Nautilus "Send with Taildrop"
  entry all refuse with the same wording, since a hidden row stops nothing that
  does not go through the row. Preferences carry a warning at the top of
  General and Help, but keep their own settings live, because which indicators
  to draw and which keys to bind mean the same thing either way.
- The poll drops to 30s while there is nothing to poll, and the extension comes
  back on its own the moment the package lands: no reload, no logout. The
  Taildrop receiver, a child of the binary that went away, is re-armed from its
  setting on the way back.
- One notification on the transition, in both directions, and none for the
  state. A machine that simply has no Tailscale said so through the panel
  before the user could look; being told again at every login is nagging about
  a fact rather than reporting an event. Losing the binary mid-session *is* an
  event, and nothing else on screen would explain it.

- A real file-manager extension, `nautilus/tailscale-taildrop.py`, loaded by
  nautilus-python out of Nautilus' own extensions directory. "Send with
  Taildrop" now sits in the context menu itself rather than three clicks down
  the Scripts submenu, and it calls the same D-Bus method the shell extension
  already exported, so the in-shell picker (the dialog the keyboard shortcut
  opens) owns the whole interaction. Its entry and tooltip come out of the
  extension's own gettext catalogues, found by resolving the symlink it was
  loaded through, so the menu is worded like the dialog it opens.
- Turning the integration on or off asks first, because it has to close the
  file manager: Nautilus reads its extensions once at startup, so the setting
  cannot reach a window already open. Confirming writes the setting and then
  quits Nautilus (`nautilus -q`, plus `flatpak kill` when the Flatpak is
  installed), which leaves the change already in place for the next window.
- Preferences grey the switch out when nautilus-python is missing, with a
  warning row naming the package. Nothing loads a Python file-manager
  extension without it, and a live switch would have promised a menu entry
  that could not appear. The probe looks for the loader module itself
  (`libnautilus-python.so`, across the libdirs distributions use) rather than
  asking a package manager.
- The link is managed by the extension: made on enable while "Nautilus
  integration" is on, dropped on disable, and pointed at the extension
  directory rather than copied out of it, so an update needs no
  re-install. Three flavours are covered: the distro package, plus the
  Flatpak and Snap sandboxes when either is present, each of which sees a
  different `$XDG_DATA_HOME`.
- A reset button on the Nautilus integration, the one row in preferences
  that was missing one. It asks before quitting the file manager, exactly as
  the switch beside it does, and only when restoring the default would
  actually change what Nautilus shows.

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
  `tailscale file get` never prints: the record behind that command
  (`apitype.WaitingFile`) holds only a name and a size, so no sender was
  ever available and the "from <peer>" half was unreachable.
- Sending as a zip crashed instead of sending: the archive options were
  handed to the Funnel port dialog rather than to the Taildrop one, so the
  send path received `undefined` where it destructured `{ asZip, password }`.

- "Extension settings" and "Admin panel" lost their bold along with
  "Taildrop" and "Funnels", which was one row too many: the two that leave
  the menu keep the weight, and only the pair that acts inside it drops it.

- A tailnet renamed in the admin console kept its old name on screen. The
  snapshot comparison that decides whether the menu is worth redrawing looked
  at the account behind a profile but not at the tailnet name (which is the
  string the rows and the submenu header are actually drawn from), so the new
  name reached the snapshot and stopped there, until some unrelated field
  happened to change and forced a redraw. A peer's Magic DNS name and OS were
  missing from the same comparison and are now compared too.
- Opening the preferences no longer writes white into the connected
  exit-node indicator colour. The colour button emitted a change while it
  was only being filled in with the stored value, and the key whose default
  is "no colour, follow the panel" was overwritten with the `#ffffff` the
  button shows in its place, so an icon that followed a light or dark theme
  became a hard white the first time the window was opened. Reset that row
  once to get the theme-following default back.
- The "Tailscale daemon" version on the Help page is re-read when the
  backend comes back, instead of keeping the answer it got when the window
  was built. Installing the package or starting the service used to leave
  that one row stale (showing "-", or the CLI version with a "Daemon
  unreachable" note) while every other live part of the window had already
  caught up. The note is now cleared as well as set, so it cannot outlive
  the state it described.

### Changed
- The extension is licensed GPL-2.0-or-later, replacing MIT. It is built
  against GNOME Shell, which is published under those same terms, and every
  source file now carries an `SPDX-License-Identifier` pointing at
  `LICENSE`, the full GPL v2 text.
- The paired "Taildrop" / "Funnels" and "Extension settings" / "Admin panel"
  buttons no longer come up bold. The shell paints every `.button` bold while
  a menu item sets itself back to normal, so those four labels were the only
  bold text in a menu of plain rows.
- The Funnels dialog is titled "Manage Funnels", saying what it is for rather
  than repeating the name of the button that opened it.
- Funnel is one dialog now, reached from a "Funnels" button beside
  "Taildrop" on a single menu row. It opens on the list of what is
  published, each entry carrying its own copy and remove button, over the
  form that publishes one more, and it stays open across both, so pruning
  a list does not mean re-opening the dialog per entry and adding one shows
  it appear. The menu keeps none of it: the Funnel submenu, its count pill
  and its inline "+" are gone, because a list you could only read was worth
  less there than the room it took.
- Every public port being taken no longer refuses to open anything. The
  dialog opens on the list that explains why, with the port row and the Add
  button greyed and a line saying to remove one first, which is the thing
  the dialog is now able to do.
- The preferences window opens at 820×700. At the size the shell chose,
  four page titles did not fit the header and "Notifications" came up
  elided to "Notifi…".
- The two shortcuts are "Open Taildrop" and "Open Funnels", both naming
  the dialog they open rather than one action inside it. Their GSettings
  keys keep the old names so a binding already made is not lost.
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
  wherever the user is, the same reason `shortcut-send-file` already
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
  total. No chooser can produce a mixed selection on its own (the portal's
  `directory` option selects folders *instead of* files, and in that mode
  picking a file returns the folder containing it), so accumulating across
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
  merged into the line that introduces the recipients: "Send 4 items
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
  button (inert until something is ticked) starts the transfer. When
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

- The description names the clipboard again, as the review guidelines require
  it to: the copy buttons write a device address or a Funnel URL, and nothing
  is ever read back. The disclosure had been there since 0.2.0 and was lost
  when the description was shortened.
- The source is laid out to match the two processes it runs in. The Quick
  Settings menu is split into `lib/menu/` (the rows, the Taildrop dialog and
  the Funnel dialog), and every preferences page into its own file under
  `prefs/`, which the shell process never loads. Both entry points shrank to
  the lifecycle they own: `extension.js` to 417 lines, `prefs.js` to 30.
- Pass over the whole codebase against the GNOME best-practices reference and
  the review tooling: dead code dropped (a signal emitted but never listened
  to, two unused methods), lifecycle flags replaced by the released references
  themselves, glyphs used as icons replaced by real icons, and repeated
  connect/disconnect pairs folded into one helper.
- The Quick Settings menu no longer opens when the `tailscale` command is
  missing from PATH or the `tailscaled` daemon does not answer. The button
  stays in the panel, without its arrow, and clicking it opens the
  preferences window instead; see below for what that window shows in this
  state. It used to open onto a banner and a dozen controls that could not
  run. The keyboard shortcut that opens the menu answers the same way, since
  it reaches past the arrow that is no longer there.
- The preferences window opens on its Help page alone in those two states,
  and the page now says whether the package is missing or the service is
  stopped rather than only the former, along with the command that fixes
  it. The other three pages come back on their own once Tailscale answers,
  with no need to reopen the window.
- The other keybindings, and the Nautilus entry, still refuse with a
  notification rather than opening a window: they were aimed at an action,
  not at the menu, and a preferences window nobody asked for would be worse
  than a line of text.
- The two exit-node indicators are one row each, "connected" and
  "disconnected", carrying the switch and the colour together with a reset
  for each. They used to be four rows whose titles said "active" and
  "status", which named the code rather than what is on screen. The
  descriptions say what the icon means and nothing else, in all three
  translations.
- Three notification and Help strings use a colon where they used an em
  dash: "Connecting Tailscale", "Tailscale is installed" and "Daemon
  unreachable". No em dash is left in any translatable string, in any of the
  four languages.
- The Nautilus integration is off by default. It reaches outside the
  extension's own directory and quits the file manager to take effect, so it
  is now opted into rather than out of.

### Removed
- The toast backend, and with it the choice of how notifications are
  presented. `lib/toast.js`, its OSD stylesheet block, the `notification-mode`
  enum and key, and `toast-duration` are gone; everything now posts as a
  native GNOME notification. One presentation is less code, and it is the one
  that keeps a history, honours a click, and obeys the user's own
  do-not-disturb, none of which a bubble painted over the desktop can do.
- Per-tailnet feature-state persistence. tailscaled already stores exit node,
  Magic DNS, accepted routes, shields, SSH and LAN access per profile and
  restores them on `tailscale switch`; the extension's copy duplicated that and
  could overwrite what the daemon had just restored.
- The per-feature visibility toggles. Hiding a block of the menu was a
  setting nobody used, and supporting it was the extension's last reason to
  write daemon state on its own: turning a feature off used to switch the
  matching tailscale setting off with it. Every block the tailnet allows is
  now always shown, and no daemon write happens unless you ask for one.
  Taildrop and Funnel keep their admin-availability detection: the
  preferences show it as a status rather than a switch, since an ACL is not
  something a checkbox can grant.

- The **Advanced → tailscale binary** setting, and the `tailscale-binary`
  key behind it. It only ever steered the unprivileged half of the
  extension: the elevated calls hardcode the program name so `pkexec`
  resolves it in its own trusted root `PATH`, and that is not going to
  change. Pointing the setting at a differently-named binary therefore
  left login, logout, operator and account switching talking to
  `tailscale` while everything else talked to something else, a broken
  extension with a plausible-looking configuration. The program name is
  now the literal `tailscale` everywhere, resolved on `PATH`.

- The two shell scripts, "Send with Taildrop" and "Send with Taildrop as
  ZIP", along with the Install / Remove buttons in preferences that copied
  them into `~/.local/share/nautilus/scripts`. Both re-implemented the D-Bus
  call in bash, and zipping is a switch inside the send dialog now. Copies
  left by 0.2.x are deleted on enable so the same action does not appear
  twice.
- The "Tailscale is not installed" banner inside the menu, and the row class
  behind it. The menu it lived in no longer opens.
- The "Start Tailscale at boot" toggle, and with it the last elevated call
  that was not `tailscale` itself: `pkexec systemctl enable/disable --now
  tailscaled.service`. Enabling a system service at boot is the
  distribution's business, it is one `systemctl` line away, and the toggle
  was the only control on the page that did not answer to a setting.

## [0.2.1] - 2026-07-14

### Changed: extensions.gnome.org review compliance
- D-Bus interface renamed `fr.diskmth.TailscaleGnome` →
  `org.gnome.Shell.Extensions.TailscaleGnome` (path
  `/org/gnome/Shell/Extensions/TailscaleGnome`). The object is now
  exported on GNOME Shell's own session connection: no bus name is
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
  `pkexec tailscale switch <id>`, one prompt, after which the target
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

### Changed: codebase audit (consistency, dead code, redundancy)
- The subprocess runner and the daemon capability lookup are now shared:
  `spawn()`, `hasCapability()` and the `CAP_*` keys live in
  `lib/util.js`, used by both the shell process and the preferences
  process. `prefs.js` no longer carries its own copy of `_spawn` nor a
  duplicated `CAP_FILE_SHARING` that a comment had to keep "in sync by
  hand": the prefs Check buttons and the startup probe now call the
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
  ports Tailscale allows (443, 8443, 10000, read from the daemon's
  CapMap, with a hardcoded fallback), greys out ports that already
  carry a funnel, and the client refuses to overwrite an occupied port
  (remove the existing funnel first). Up to three funnels can now run
  side by side from the menu; add/remove toasts name the public port.
- Spontaneous connection-progress toast: when the daemon enters the
  `Starting` state outside of a user-initiated action (typically while
  tailscaled is still establishing the session right after boot or
  login), a sticky spinner toast says the connection is in progress
  and resolves in place to "Tailscale connected", or to the current
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
