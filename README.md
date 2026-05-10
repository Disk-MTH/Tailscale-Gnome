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
- **The user running gnome-shell must be the Tailscale operator.** Without
  this, every state-changing call (`up`, `down`, `set`, `switch`) is rejected
  by the daemon with "Access denied: …" — and worse, the CLI still exits 0,
  so failures are silent. Set it once with:

  ```bash
  sudo tailscale set --operator=$USER
  ```

  The extension detects the missing operator and shows a banner at the top of
  the menu with the exact command to run; clicking it copies it to your
  clipboard.

## Install (from source)

```bash
git clone https://github.com/diskmth/tailscale-gnome.git
cd tailscale-gnome
make install
# Wayland: log out / log in.
# Xorg:    Alt+F2, type "r", press Enter.
gnome-extensions enable tailscale-gnome@diskmth.fr
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
# produces tailscale-gnome@diskmth.fr.shell-extension.zip
```

This is the file you upload to <https://extensions.gnome.org/upload/>.

## Settings

Open with `gnome-extensions prefs tailscale-gnome@diskmth.fr` or click
**Tailscale Settings…** in the menu.

| Key                       | Default       | Effect                                     |
| ------------------------- | ------------- | ------------------------------------------ |
| `poll-interval`           | `5`           | Seconds between status polls (2–60)        |
| `show-indicator`          | `true`        | Show panel icon while connected            |
| `indicator-always-visible`| `false`       | Show the panel icon even when stopped      |
| `show-subtitle`           | `true`        | Show account/status under the toggle title |
| `tailscale-binary`        | `'tailscale'` | Override CLI path                          |

## Debugging

Tail extension logs in a terminal:

```bash
journalctl --user -f /usr/bin/gnome-shell | grep -iE 'tailscale|extension'
```

Or use the **Tail extension logs** task in VS Code (`Ctrl+Shift+P` → `Tasks: Run Task`).

For interactive inspection, open Looking Glass with `Alt+F2`, type `lg`, press
Enter. The `Errors` tab lists every error thrown by any extension since the
shell started.

Inspect what the extension is polling:

```bash
tailscale status --json | jq .          # state the UI binds to
tailscale debug prefs   | jq .          # toggle states + OperatorUser
tailscale switch --list                 # accounts (requires operator)
```

Iteration loop without logging out (Wayland-friendly):

```bash
make install
dbus-run-session -- gnome-shell --nested --wayland
# the nested shell loads the freshly installed code
```

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
