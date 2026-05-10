# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- prefs.js used the wrong resource path for `ExtensionPreferences`
  (`resource:///org/gnome/shell/extensions/prefs.js`); switched to the
  canonical `resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js`
  so the preferences dialog opens on GNOME 46–50.

### Changed
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
