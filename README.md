# Tailscale for GNOME

A modern GNOME Shell extension that drops Tailscale into the **Quick Settings**
panel — connect/disconnect, switch accounts, pick exit nodes, browse peers,
toggle accept-routes / accept-DNS / allow-LAN / shields-up / SSH — all without
opening a terminal. UI auto-refreshes when state changes from outside (CLI,
another extension, the daemon).

> Built because the older _Tailscale QS_ stopped getting updates and
> _Tailscale Status_ doesn't feel native. Targets GNOME 46 → 50.

## Features

- **Quick toggle** — flips Tailscale on/off (`tailscale up` / `tailscale down`).
- **System indicator icon** next to Wi-Fi while connected.
- **Header** with current device, account, and Tailscale IP.
- **Exit nodes** submenu — `auto:any`, every advertised exit node, "None".
  Active exit node is highlighted.
- **Peers** submenu — every node in the tailnet with online/offline state and a
  "Copy IP" action.
- **Preferences** submenu — Accept routes, Accept DNS, Allow LAN access,
  Shields up, SSH server.
- **Account** submenu — switch between logged-in tailnets, login, logout.
- **Refresh** entry — force an immediate `tailscale status` poll.
- **Auto-refresh** — polls `tailscale status --json` on a configurable interval
  (default 5 s) so external CLI changes show up automatically.

## Requirements

- GNOME Shell **46 – 50**
- `tailscale` ≥ 1.70 on `PATH`
- The user running gnome-shell must be the Tailscale **operator**, otherwise
  state-changing commands need `sudo`. Set it once with:

  ```bash
  sudo tailscale set --operator=$USER
  ```

## Install (from source)

```bash
git clone https://github.com/diskmth/tailscale-gnome.git
cd tailscale-gnome
make install
# Wayland: log out / log in.
# Xorg:    Alt+F2, type "r", press Enter.
gnome-extensions enable tailscale-gnome@diskmth.github.io
```

To test without restarting your session:

```bash
make install
dbus-run-session -- gnome-shell --nested --wayland
# enable from the nested shell
```

## Pack a release zip

```bash
make pack
# produces tailscale-gnome@diskmth.github.io.shell-extension.zip
```

This is the file you upload to <https://extensions.gnome.org/upload/>.

## Settings

Open with `gnome-extensions prefs tailscale-gnome@diskmth.github.io` or click
**Tailscale Settings…** in the menu.

| Key                       | Default       | Effect                                     |
| ------------------------- | ------------- | ------------------------------------------ |
| `poll-interval`           | `5`           | Seconds between status polls (2–60)        |
| `show-indicator`          | `true`        | Show panel icon while connected            |
| `indicator-always-visible`| `false`       | Show the panel icon even when stopped      |
| `show-subtitle`           | `true`        | Show account/status under the toggle title |
| `tailscale-binary`        | `'tailscale'` | Override CLI path                          |

## Debugging

```bash
journalctl --user -f /usr/bin/gnome-shell | grep -i tailscale
```

Or open Looking Glass (`Alt+F2`, type `lg`, Enter) and inspect the extension.

## Project layout

```
tailscale-gnome/
├── extension.js            # ESM entry — owns the indicator
├── prefs.js                # Adw preferences dialog
├── stylesheet.css
├── lib/
│   ├── tailscale.js        # Promise-based CLI wrapper + poller
│   ├── indicator.js        # SystemIndicator (panel icon)
│   └── menu.js             # QuickMenuToggle + every submenu
├── icons/                  # symbolic SVGs (active / disabled)
├── schemas/                # GSettings schema
├── Makefile                # build / install / pack
└── metadata.json
```

## License

MIT — see [LICENSE](./LICENSE).
