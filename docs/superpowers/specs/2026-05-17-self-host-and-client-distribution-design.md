# Self-Host Server + Client Distribution Design

## Overview

Host the aux WebSocket server on a personal machine, permanently reachable over the internet via Cloudflare Tunnel, and distribute a single `aux` npm package that bundles the daemon and TUI client together.

---

## 1. Monorepo Changes

Delete `packages/client` and `packages/daemon`. Create `packages/aux` — a merged package that publishes to npm as `aux`. Update the root `package.json` workspaces array to `["packages/server", "packages/aux"]`.

```
packages/
  server/          ← unchanged
  aux/             ← new: daemon + client merged
    bin/
      aux.ts       ← TUI entry (from packages/client)
      auxd.ts      ← daemon entry (from packages/daemon)
    src/
      constants.ts ← SERVER_URL baked in here
      ... all daemon + client source files
    package.json   ← name: "aux", two bin entries
```

`packages/aux/src/constants.ts` contains the server URL as a single hardcoded string:

```ts
export const SERVER_URL = "wss://aux.yourdomain.com";
```

When migrating to a hosted server, update this string and publish a new npm version.

---

## 2. First-Run Dependency Management

On first `auxd` start, a `deps-check` module runs before any other logic. It downloads missing tools into `~/.aux/bin/` and prepends that path to subprocess `PATH`. System-installed binaries take precedence — download is skipped if the tool is already on `PATH`.

### yt-dlp

Auto-downloaded on all platforms from GitHub releases (version-pinned):

| Platform | Binary |
|---|---|
| macOS (arm64/x64) | `yt-dlp_macos` |
| Linux (x64) | `yt-dlp` |
| Windows (x64) | `yt-dlp.exe` |

### mpv

| Platform | Strategy |
|---|---|
| macOS | Check `which mpv`. If missing, print `brew install mpv` hint and exit |
| Windows | Download portable zip from mpv.io sourceforge mirror, extract `mpv.exe` into `~/.aux/bin/` |
| Linux | Check `which mpv`. If missing, print distro-appropriate install hint and exit |

Install hint examples:
- macOS: `brew install mpv`
- Debian/Ubuntu: `sudo apt install mpv`
- Arch: `sudo pacman -S mpv`
- Fedora: `sudo dnf install mpv`

Both tools are version-pinned in `constants.ts` so updates are deliberate.

---

## 3. Server Setup

The server is unchanged in code. Two additions:

1. **Bind to `0.0.0.0`** — verify the server's `ws.Server` and HTTP listener bind to all interfaces, not just `localhost`.

2. **`.env.example`** — committed to `packages/server/`:

```
PORT=7700
JWT_SECRET=change-me
DATABASE_PATH=./aux.db
ANTHROPIC_API_KEY=
```

---

## 4. Cloudflare Tunnel

Cloudflare Tunnel gives the server a permanent public URL that survives IP changes and reboots. The URL never changes unless the tunnel is explicitly deleted and recreated.

### One-time setup

```bash
# Install cloudflared
brew install cloudflare/cloudflare/cloudflared   # macOS
# or download from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# Authenticate
cloudflared tunnel login

# Create named tunnel
cloudflared tunnel create aux

# Configure tunnel
# ~/.cloudflared/config.yml:
# tunnel: <tunnel-id>
# credentials-file: ~/.cloudflared/<tunnel-id>.json
# ingress:
#   - hostname: aux.yourdomain.com
#     service: http://localhost:7700
#   - service: http_status:404

# Add DNS record (CNAME in Cloudflare dashboard pointing to tunnel)
cloudflared tunnel route dns aux aux.yourdomain.com

# Install as system service (auto-starts on boot)
cloudflared service install
```

### Behaviour

- Survives IP changes — Cloudflare tracks your machine via the outbound tunnel, not your IP
- Survives reboots — `cloudflared` registered as launchd (macOS) / systemd (Linux) / Windows Service
- Survives server process restarts — tunnel is independent of the aux server process
- `wss://aux.yourdomain.com` is the value baked into `SERVER_URL` in the client package

### Server auto-start

The aux server also needs to survive reboots. Register it as a system service alongside `cloudflared`:

- **macOS:** launchd plist in `~/Library/LaunchAgents/`
- **Linux:** systemd user unit
- **Windows:** Task Scheduler or NSSM

A `scripts/install-service.sh` (macOS/Linux) and `scripts/install-service.ps1` (Windows) will be provided.

---

## 5. User Experience

### Server owner (one-time setup)

```bash
# 1. Set up Cloudflare Tunnel (see Section 4)
# 2. Configure .env from .env.example
# 3. Install server as system service
# Done — server and tunnel auto-start on boot
```

### Anyone connecting

```bash
npm install -g aux
auxd   # first run: downloads yt-dlp + mpv, connects to wss://aux.yourdomain.com
aux    # attaches TUI
```

---

## 6. Out of Scope

- Router/firewall configuration (not needed — Cloudflare Tunnel is outbound only)
- Server-side auth changes
- The Cloudflare account itself (user must have a domain on Cloudflare)
