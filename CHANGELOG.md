# Changelog

All notable changes to this project will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
