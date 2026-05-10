# Tailscale for GNOME

A GNOME Shell extension that puts Tailscale into the Quick Settings panel.
Connect, disconnect, switch accounts, pick exit nodes, browse peers, flip
prefs (Accept routes, Accept DNS, Allow LAN, Shields up, SSH), all without
opening a terminal.

The UI auto-refreshes when state changes from outside (CLI, another
extension, the daemon).

## Why

The older _Tailscale QS_ stopped getting updates and _Tailscale Status_
felt off on recent GNOME releases. This is a clean rewrite for GNOME 46
through 50, ESM-only, with proper async I/O and reactive rendering.

## Features

- Quick Settings toggle for `tailscale up` / `tailscale down`.
- Panel indicator next to Wi-Fi when connected.
- Peers list with online/offline state and a "Copy IP" action.
- Exit-node picker with "None", "Automatic", and every approved exit node.
  Allow LAN access lives inside this submenu, where it actually matters.
- Toggles for Accept DNS (with the MagicDNS suffix as a hint), Accept
  routes (with route count), Shields up, and the SSH server.
- Tailnet routes submenu showing every advertised CIDR. Hidden when
  Accept routes is off or no peer advertises one.
- Account switcher that preserves your connection state across switches.
- Login / logout entries.
- Configurable polling interval.
- Configurable keyboard shortcuts (toggle, exit node, open menu, copy IP).
- Optional "Start Tailscale at boot" toggle in preferences.

## Requirements

- GNOME Shell 46 to 50.
- `tailscale` 1.70 or newer on `PATH`.
- The user running gnome-shell must be the Tailscale operator. Without
  it, every state-changing call is silently denied by the daemon (it even
  exits with code 0). Set it once with:

  ```bash
  sudo tailscale set --operator=$USER
  ```

  The Operator status row in the extension preferences shows whether
  this is set, and copies the fix command to the clipboard when it's not.

## Install (from source)

```bash
git clone https://github.com/Disk-MTH/Tailscale-Gnome.git
cd Tailscale-Gnome
make install
# Wayland: log out and back in.
# Xorg:    Alt+F2, type r, press Enter.
gnome-extensions enable tailscale-gnome@diskmth.fr
```

To iterate without restarting your session:

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

That zip is what you upload to <https://extensions.gnome.org/upload/>.

## Settings

Open with `gnome-extensions prefs tailscale-gnome@diskmth.fr` or click
**Extension settings** in the menu.

| Group     | Setting                       | Default       | Effect                                       |
| --------- | ----------------------------- | ------------- | -------------------------------------------- |
| Operator  | (read-only status)            | n/a           | Reflects `OperatorUser` from `debug prefs`   |
| Service   | Start Tailscale at boot       | system        | `systemctl enable/disable --now tailscaled`  |
| Display   | Show panel indicator          | on            | Show the icon next to Wi-Fi while connected  |
| Display   | Show subtitle on the toggle   | on            | Show account/status under the toggle title   |
| Shortcuts | Connect / disconnect          | unbound       | Click row to capture keys                    |
| Shortcuts | Toggle automatic exit node    | unbound       | Click row to capture keys                    |
| Shortcuts | Open the Tailscale menu       | unbound       | Click row to capture keys                    |
| Shortcuts | Copy this device's IP         | unbound       | Click row to capture keys                    |
| Advanced  | Poll interval                 | 5             | Seconds between status polls (2 to 60)       |
| Advanced  | tailscale binary              | `'tailscale'` | Override CLI path                            |

## Debugging

Tail extension logs in a terminal:

```bash
journalctl --user -f /usr/bin/gnome-shell | grep -iE 'tailscale|extension'
```

For interactive inspection, open Looking Glass with `Alt+F2`, type `lg`,
press Enter. The `Errors` tab lists every error thrown by any extension
since the shell started.

Inspect what the extension is polling:

```bash
tailscale status --json | jq .   # state the UI binds to
tailscale debug prefs   | jq .   # toggle states + OperatorUser
tailscale switch --list          # accounts (requires operator)
```

Iteration loop without logging out (Wayland-friendly):

```bash
make install
dbus-run-session -- gnome-shell --nested --wayland
# the nested shell loads the freshly installed code
```

## Project layout

```
Tailscale-Gnome/
├── extension.js            # ESM entry, owns the indicator and shortcuts
├── prefs.js                # Adw preferences dialog
├── stylesheet.css
├── lib/
│   ├── tailscale.js        # Promise-based CLI wrapper + poller
│   ├── indicator.js        # SystemIndicator (panel icon)
│   └── menu.js             # QuickMenuToggle and submenus
├── icons/                  # symbolic SVGs (active / disabled)
├── schemas/                # GSettings schema
├── Makefile                # build / install / pack
└── metadata.json
```

## License

MIT, see [LICENSE](./LICENSE).
