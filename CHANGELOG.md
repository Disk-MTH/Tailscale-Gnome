# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- Disconnect now actually disconnects: switched the QuickMenuToggle to
  `toggleMode: true` and dispatch on the post-click `this.checked`. Previous
  build relied on `clicked` + `toggleMode: false`, which under GNOME 50
  failed to surface user-intent reliably.
- The Tailscale CLI exits with code 0 even when it printed "Access denied:
  …" on stderr (typically because OperatorUser is unset on Linux).
  `_runAndRefresh` now treats that wording as a failure regardless of exit
  code and emits a notification.
- Account submenu shows "No accounts" wrongly when `tailscale switch --list`
  is denied. Now falls back to showing the current tailnet (read-only) and a
  "switching disabled" hint when access is denied.
- prefs.js used the wrong resource path for `ExtensionPreferences`
  (`resource:///org/gnome/shell/extensions/prefs.js`); switched to the
  canonical `resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js`
  so the preferences dialog opens on GNOME 46–50.

### Changed
- Menu reordered for compactness: IP → Account submenu → separator →
  Exit-node submenu → Peers submenu → separator → 5 toggles → separator →
  Refresh / Settings. Dropped the redundant standalone "Account" info row
  and the duplicate Connect/Disconnect action (the toggle itself handles
  on/off).
- Account submenu now shows the active account directly in its label
  (`Account: gillet.fra@free.fr`) so users see the current tailnet at a
  glance without expanding.
- Operator-not-set surface: a banner row at the top of the menu copies the
  fix command to the clipboard on click; toggle rows become non-reactive in
  this state.
- `tailscale up` no longer carries `--reset` (it cleared every preference);
  the CLI's plain `up` connects without touching prefs.
- `.vscode/tasks.json` slimmed from 15 entries to 6 (Install, Pack, Open
  preferences, Tail logs, Launch nested shell, Validate syntax). All labels
  and details translated to English.
- README gained a clearer Debugging section (journalctl one-liner,
  Looking Glass, nested-shell iteration loop) and an explicit operator
  requirement explanation.
- UUID renamed `tailscale-gnome@diskmth.github.io` →
  `tailscale-gnome@diskmth.fr`. Re-login required to switch.

### Added
- `.vscode/` workspace config: tasks (install / pack / reload / nested
  shell / log tail / prefs / syntax-check / dconf reset / uninstall /
  status JSON / debug prefs), launch configurations, recommended
  extensions, GJS-aware editor settings.
- `jsconfig.json` for IntelliSense.
- `.editorconfig` for consistent indentation across editors.

## [0.1.0] - 2026-05-10

### Added
- Quick Settings toggle with Tailscale on/off
- System indicator icon next to Wi-Fi when Tailscale is up
- Header showing current device, account, and Tailscale IP
- Exit-node submenu with "auto:any", per-peer selection, "None" option
- Peers submenu listing online/offline nodes with "Copy IP" action
- Preferences submenu: Accept routes, Accept DNS, Allow LAN access,
  Shields up, Run SSH server
- Account submenu: switch between logged-in tailnets, login, logout
- Refresh entry to force an immediate state poll
- Preferences dialog (poll interval, indicator visibility, subtitle text)
- Auto-refresh on external CLI changes (configurable polling)
- GSettings schema, Makefile (build / install / pack), MIT license
