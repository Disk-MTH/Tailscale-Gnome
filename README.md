# Tailscale for GNOME

A GNOME Shell extension that drops Tailscale into the Quick Settings panel.
Connect, switch accounts, pick exit nodes, expose services via Funnel, and
send/receive files with Taildrop — no terminal required.

## Features

- **Quick toggle** in Quick Settings for connect / disconnect, with a
  panel icon next to Wi-Fi while connected.
- **Operator setup** in one click. Polkit prompts for the `tailscale set
  --operator=$USER` step automatically when needed; login and logout are
  wrapped so the operator pref survives a profile switch.
- **Account switcher** that always reconnects after a switch.
- **Peers** list with online state and copy-IP.
- **Exit node** picker (None / Auto / per-peer) with a status pill that
  reflects offline or unavailable nodes truthfully.
- **Prefs toggles** for Accept DNS, Accept routes, Shields up, SSH server,
  Allow LAN access.
- **Funnel** management from the menu: add a port, copy each public URL,
  remove. If the tailnet hasn't approved Funnel yet, the admin page opens
  automatically.
- **Taildrop** receive (background `tailscale file get --loop` writing to
  a configurable inbox) and send via a file picker → peer picker flow.
- **Nautilus integration** (optional): right-click any file or folder for
  "Send with Taildrop" / "Send with Taildrop as ZIP".
- **Keyboard shortcuts**: toggle Tailscale, toggle exit node, open menu,
  copy self-IP, open admin console, send file via Taildrop. All unbound
  by default — bind what you use.

## Requirements

- GNOME Shell 46 → 50.
- `tailscale` 1.70+ on `PATH`.
- `zenity` for the send-file flow (already installed on most GNOME
  systems).
- `pkexec` (polkit) for the privileged calls.

## Install

```bash
git clone https://github.com/Disk-MTH/Tailscale-Gnome.git
cd Tailscale-Gnome
make install
# Wayland: log out, log back in.
# Xorg:    Alt+F2, type r, Enter.
gnome-extensions enable tailscale-gnome@diskmth.fr
```

Pack a release zip with `make pack`. Upload the resulting `.zip` to
<https://extensions.gnome.org/upload/>.

## Settings

Open with `gnome-extensions prefs tailscale-gnome@diskmth.fr` or click
**Extension settings** in the menu.

| Group               | Setting                       | Default       |
| ------------------- | ----------------------------- | ------------- |
| Display             | Show panel indicator          | on            |
| Taildrop            | Accept incoming files         | off           |
| Taildrop            | Inbox folder                  | `~/Downloads/Taildrop` |
| File manager        | Nautilus right-click scripts  | not installed |
| Shortcuts           | Connect / disconnect          | unbound       |
| Shortcuts           | Toggle automatic exit node    | unbound       |
| Shortcuts           | Open the Tailscale menu       | unbound       |
| Shortcuts           | Copy this device's IP         | unbound       |
| Shortcuts           | Open the admin console        | unbound       |
| Shortcuts           | Send a file via Taildrop      | unbound       |
| Advanced            | Start Tailscale at boot       | system        |
| Advanced            | Poll interval                 | 5s            |
| Advanced            | tailscale binary              | `tailscale`   |

## Debugging

```bash
# Live extension logs
journalctl --user -f /usr/bin/gnome-shell | grep -iE 'tailscale|extension'

# What the UI sees
tailscale status --json | jq .
tailscale debug prefs   | jq .
```

Looking Glass (`Alt+F2`, type `lg`) lists errors thrown since the shell
started.

## Project layout

```
extension.js            # entry point, indicator + shortcuts
prefs.js                # Adw preferences dialog
lib/
├── tailscale.js        # CLI wrapper + poller
├── indicator.js        # panel icon
└── menu.js             # Quick Settings toggle + submenus
nautilus/               # Right-click scripts (installed on demand)
icons/  schemas/  stylesheet.css
```

## License

MIT, see [LICENSE](./LICENSE).
