# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
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
- Preferences dialog reorganized:
  Operator status, Service, Display (panel indicator + toggle subtitle),
  Shortcuts, Advanced (poll interval + binary path).
- Removed the "Always visible" panel-indicator option (and the
  `indicator-always-visible` GSettings key). The icon now follows
  `show-indicator` and the running state.
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
