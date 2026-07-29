# Tailscale for GNOME

A GNOME Shell extension that drops Tailscale into the Quick Settings panel.
Connect, switch accounts, pick exit nodes, expose services via Funnel, and
send/receive files with Taildrop — no terminal required.

> **Heads up — vibe-coded.** This extension was largely written through
> AI-assisted iteration on real-world usage, not from a formal spec.
> The code is reviewed and tested but you may find rough edges; bug
> reports are very welcome.

> **Trademark notice.** This project is an independent, community-built
> extension. It is **not affiliated with, sponsored by, or endorsed by
> Tailscale Inc.** "Tailscale" is a trademark of Tailscale Inc., used
> here in a purely nominative sense to describe what the extension
> integrates with.

## Features

- **Quick toggle** in Quick Settings for connect / disconnect, with a
  panel icon next to Wi-Fi while connected.
- **Operator setup** in one click. Polkit prompts for the `tailscale set
  --operator=$USER` step automatically when needed; login and logout
  are wrapped so the operator pref survives a profile switch.
- **Account switcher** that always reconnects after a switch. Per-profile
  settings — exit node, Magic DNS, accepted routes — are restored by
  tailscaled itself, so the extension keeps no copy of them.
- **Peers** list with online state and copy-IP.
- **Exit node** picker (None / Auto / per-peer) with a status pill that
  reflects offline or unavailable nodes truthfully, plus a panel warning
  glyph when the selected node can no longer route.
- **Menu toggles** for Magic DNS, Accept routes, Shields up, SSH
  server, Allow LAN access.
- **Funnel** management from the menu: add a port, copy each public
  URL, remove. If the tailnet hasn't approved Funnel yet, the admin
  page opens automatically.
- **Taildrop** receive (background `tailscale file get --loop` writing
  to a configurable inbox) and send via a file picker → peer picker
  flow.
- **Nautilus integration** (optional): right-click any file or folder
  for "Send with Taildrop" / "Send with Taildrop as ZIP". The scripts
  hand the selection to the extension over D-Bus
  (`org.gnome.Shell.Extensions.TailscaleGnome` on the `org.gnome.Shell`
  bus name) and the native in-shell peer picker takes over.
- **Keyboard shortcuts**: toggle Tailscale, toggle exit node, open menu,
  open admin console, send file via Taildrop. All unbound by default —
  bind what you use.

## Requirements

- GNOME Shell 49 → 50.
- `tailscale` 1.70+ on `PATH`.
- `pkexec` (polkit) for the privileged calls listed below.

File pickers use the XDG Desktop Portal (`org.freedesktop.portal.
FileChooser`), which ships with every GNOME session — no external
dialog tool is spawned.

## Privileged operations

On Linux the Tailscale daemon only accepts state-changing commands from
root or from the Unix user named in its `OperatorUser` pref. The
extension therefore runs a **small, fixed set** of commands through
`pkexec`, each behind an interactive polkit password prompt:

| Command | When it runs |
| ------- | ------------ |
| `pkexec tailscale set --operator=$USER` | Once at session startup if the operator pref is missing while logged in, and when you click **Set operator** in the menu. Makes every later command work unprivileged. |
| `pkexec tailscale login --operator=$USER` | When you click **Login**. Tailscale denies plain `tailscale login` on operator-set profiles ("checkprefs access denied"), and `--operator` keeps the pref on the new profile — including after a logout, so logging back in never needs an extra elevation. |
| `pkexec tailscale logout` | When you click **Logout**. One prompt only: the operator pref disappears with the discarded profile and the next **Login** restores it via its `--operator` flag; the menu keeps the Login entry and the account list reachable meanwhile (see the `switch` row below). |
| `pkexec tailscale switch <profile-id>` | When you pick another account while control is denied (typically right after a logout). The profile id comes from the daemon's own `switch --list` output and is validated as a plain token; once on the target profile its own operator pref applies, so no further prompt follows. |
| `pkexec systemctl enable/disable --now tailscaled.service` | Only from the **Start Tailscale at boot** toggle in the preferences window. |

Safeguards:

- Every elevated command is a **literal argument vector**, readable
  as-is in the source — nothing typed by a user, read from a file or
  built at runtime is ever concatenated into it (no `sh -c`).
- Elevated calls hardcode the `tailscale` program name; `pkexec`
  resolves it in its own trusted root `PATH`. The **Advanced →
  tailscale binary** setting is deliberately ignored for privileged
  calls, so a user-writable path can never be elevated.

Prefer to avoid polkit prompts entirely? Run this once in a terminal
and the extension will never need to elevate for day-to-day use:

```bash
sudo tailscale set --operator=$USER
```

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

| Page          | Setting                            | Default       |
| ------------- | ---------------------------------- | ------------- |
| General       | Availability: Taildrop / Funnel    | read from every poll |
| General       | Taildrop inbox folder              | `~/Downloads/Taildrop` |
| General       | Taildrop Nautilus right-click scripts | not installed |
| General       | Start Tailscale at boot            | system        |
| General       | Show panel indicator               | on            |
| General       | Show exit node active indicator    | on            |
| General       | Exit node active indicator colour  | theme         |
| General       | Show exit node status indicator    | on            |
| General       | Exit node indicator colour         | `#e6b800`     |
| General       | Poll interval                      | 3s            |
| General       | tailscale binary                   | `tailscale`   |
| Notifications | Minimum pending duration           | 1000ms        |
| Notifications | Per-category reporting (nine of them, All / Errors / Off) | all |
| Shortcuts     | Connect / disconnect               | unbound       |
| Shortcuts     | Toggle automatic exit node         | unbound       |
| Shortcuts     | Open the Tailscale menu            | unbound       |
| Shortcuts     | Open the admin console             | unbound       |
| Shortcuts     | Send a file via Taildrop           | unbound       |
| Help          | Versions, source and issue links   | read-only     |

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
├── menu.js             # Quick Settings toggle + submenus
├── watchers.js         # snapshot diffing into semantic events
├── notify-policy.js    # category, level and quiet-window rules
├── notify.js           # notification entry point
├── tray.js             # notification backend (MessageTray.Source)
└── util.js             # helpers shared by shell and prefs processes
nautilus/               # right-click scripts (installed on demand)
icons/  schemas/  stylesheet.css
```

## License

MIT, see [LICENSE](./LICENSE).
