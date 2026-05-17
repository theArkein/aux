# Self-Host Server + Client Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `packages/daemon` and `packages/client` into a single `aux` npm package with first-run yt-dlp/mpv download, and add server 0.0.0.0 binding + system-service scripts for always-on hosting.

**Architecture:** The two user-facing packages (daemon + TUI client) merge into `packages/aux` with two bin entries (`aux` and `auxd`). A new `deps-check` module downloads yt-dlp on all platforms and mpv on Windows on first `auxd` run; macOS/Linux users get a one-line install hint if mpv is missing. The server gains an explicit 0.0.0.0 binding and a launchd/systemd/PowerShell service-install script for always-on hosting.

**Tech Stack:** TypeScript (strict, NodeNext modules), Node.js ≥ 20, `node:https` + `node:fs` for binary downloads, Ink + React for TUI, `ws` for WebSocket.

---

## File Map

**Create:**
- `packages/aux/package.json`
- `packages/aux/tsconfig.json`
- `packages/aux/src/constants.ts` — SERVER_URL, IPC_PATH, PID_FILE, dep version pins + download URLs
- `packages/aux/src/deps-check.ts` — first-run yt-dlp + mpv download logic
- `packages/aux/src/credentials.ts` — copy from daemon (identical to client's)
- `packages/aux/src/ipc-server.ts` — copy from daemon
- `packages/aux/src/ipc-client.ts` — copy from client
- `packages/aux/src/playback-engine.ts` — copy from daemon
- `packages/aux/src/spotify-client.ts` — copy from daemon
- `packages/aux/src/ws-client.ts` — copy from daemon
- `packages/aux/src/youtube-resolver.ts` — copy from daemon
- `packages/aux/src/yt-cache.ts` — copy from daemon
- `packages/aux/src/App.tsx` — copy from client
- `packages/aux/bin/auxd.ts` — based on daemon's, imports SERVER_URL + depsCheck from new locations
- `packages/aux/bin/aux.ts` — based on client's, imports SERVER_URL from constants, updates DAEMON_BIN path
- `packages/server/.env.example`
- `scripts/install-service.sh` — macOS launchd + Linux systemd install
- `scripts/install-service.ps1` — Windows Task Scheduler install

**Modify:**
- `packages/server/src/server.ts` — add explicit `'0.0.0.0'` host to `httpServer.listen()`
- Root `package.json` — update workspaces to `["packages/server", "packages/aux"]`

**Delete:**
- `packages/client/` (entire directory)
- `packages/daemon/` (entire directory)

---

## Task 1: Server 0.0.0.0 binding + .env.example

**Files:**
- Modify: `packages/server/src/server.ts:46`
- Create: `packages/server/.env.example`

Node.js `server.listen(port, callback)` defaults to `'::'` on dual-stack systems — passing `'0.0.0.0'` makes the IPv4 binding explicit and guaranteed across all platforms.

- [ ] **Step 1: Update listen call**

In `packages/server/src/server.ts`, change line 46 from:
```ts
  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
```
to:
```ts
  await new Promise<void>((resolve) => httpServer.listen(port, '0.0.0.0', resolve));
```

- [ ] **Step 2: Create .env.example**

Create `packages/server/.env.example`:
```
PORT=3000
JWT_SECRET=change-me-to-a-long-random-string
DATABASE_PATH=./aux.db
ANTHROPIC_API_KEY=
```

- [ ] **Step 3: Verify server starts and binds correctly**

```bash
cd packages/server && JWT_SECRET=test tsx src/server.ts &
sleep 1
# Should show a connection from an external IP, not just localhost
curl -s http://0.0.0.0:3000 || echo "connected (expected non-200 or refused - server is WS-only)"
kill %1
```

Expected: server process starts without error, `aux-server listening on :3000` is printed.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/server.ts packages/server/.env.example
git commit -m "feat(server): bind to 0.0.0.0 explicitly; add .env.example"
```

---

## Task 2: Create packages/aux scaffold

**Files:**
- Create: `packages/aux/package.json`
- Create: `packages/aux/tsconfig.json`
- Modify: root `package.json`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p packages/aux/bin packages/aux/src
```

- [ ] **Step 2: Create packages/aux/package.json**

```json
{
  "name": "aux",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "aux": "./dist/bin/aux.js",
    "auxd": "./dist/bin/auxd.js"
  },
  "files": ["dist"],
  "scripts": {
    "dev:aux": "tsx bin/aux.ts",
    "dev:auxd": "tsx bin/auxd.ts",
    "build": "tsc",
    "prepublishOnly": "npm run build"
  },
  "dependencies": {
    "ink": "^5.0.0",
    "react": "^18.0.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^18.0.0",
    "@types/ws": "^8.5.13",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 3: Create packages/aux/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "jsx": "react-jsx"
  },
  "include": ["bin/**/*", "src/**/*"]
}
```

- [ ] **Step 4: Update root package.json workspaces**

In the root `package.json`, change:
```json
  "workspaces": [
    "packages/*"
  ],
```
to:
```json
  "workspaces": [
    "packages/server",
    "packages/aux"
  ],
```

- [ ] **Step 5: Install to register the new workspace**

```bash
npm install
```

Expected: no errors. `packages/aux` is now a registered workspace.

- [ ] **Step 6: Commit**

```bash
git add packages/aux/package.json packages/aux/tsconfig.json package.json package-lock.json
git commit -m "feat(aux): scaffold merged aux package; update workspaces"
```

---

## Task 3: Create packages/aux/src/constants.ts

**Files:**
- Create: `packages/aux/src/constants.ts`

This file holds all shared constants: baked-in server URL, IPC paths, and version-pinned download URLs for yt-dlp and mpv. Keeping versions here makes upgrades a one-line change.

- [ ] **Step 1: Create constants.ts**

```ts
import { join } from 'node:path';
import { homedir } from 'node:os';

export const SERVER_URL = 'wss://aux.yourdomain.com';

export const IPC_PATH = '/tmp/aux.sock';
export const PID_FILE = '/tmp/aux.pid';

export const AUX_BIN_DIR = join(homedir(), '.aux', 'bin');

export const YT_DLP_VERSION = '2025.01.15';

export const YT_DLP_URL: Record<NodeJS.Platform, string | null> = {
  darwin: `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp_macos`,
  linux: `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp`,
  win32: `https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp.exe`,
  aix: null, freebsd: null, openbsd: null, sunos: null, netbsd: null, cygwin: null, android: null,
};

export const MPV_WINDOWS_ZIP_URL =
  'https://sourceforge.net/projects/mpv-player-windows/files/64bit/mpv-x86_64-20240901-git-9c6d56f.7z/download';
```

> **Note:** Replace `'wss://aux.yourdomain.com'` with your actual Cloudflare Tunnel URL after setup. Update `YT_DLP_VERSION` and `MPV_WINDOWS_ZIP_URL` when newer versions are released.

- [ ] **Step 2: Commit**

```bash
git add packages/aux/src/constants.ts
git commit -m "feat(aux): add constants — SERVER_URL, IPC paths, dep download URLs"
```

---

## Task 4: Create packages/aux/src/deps-check.ts

**Files:**
- Create: `packages/aux/src/deps-check.ts`

Runs on every `auxd` start. Checks `~/.aux/bin/` and system PATH for yt-dlp and mpv. Downloads missing tools. On platforms where auto-download is not supported (macOS/Linux for mpv), prints a one-line install hint and exits.

- [ ] **Step 1: Create deps-check.ts**

```ts
import { existsSync, mkdirSync, createWriteStream, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { AUX_BIN_DIR, YT_DLP_URL, MPV_WINDOWS_ZIP_URL } from './constants.js';

function isOnPath(bin: string): boolean {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isInAuxBin(name: string): boolean {
  return existsSync(join(AUX_BIN_DIR, name));
}

async function downloadFile(url: string, dest: string): Promise<void> {
  mkdirSync(AUX_BIN_DIR, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    function get(u: string): void {
      https.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          get(res.headers.location!);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode} for ${u}`));
          return;
        }
        const out = createWriteStream(dest);
        pipeline(res, out).then(resolve).catch(reject);
      }).on('error', reject);
    }
    get(url);
  });
}

async function ensureYtDlp(): Promise<void> {
  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  if (isOnPath('yt-dlp') || isInAuxBin(binName)) return;

  const url = YT_DLP_URL[process.platform];
  if (!url) {
    console.error(`[auxd] yt-dlp not found and no download available for ${process.platform}.`);
    console.error('       Install manually: https://github.com/yt-dlp/yt-dlp#installation');
    process.exit(1);
  }

  console.log('[auxd] downloading yt-dlp...');
  const dest = join(AUX_BIN_DIR, binName);
  await downloadFile(url, dest);
  if (process.platform !== 'win32') chmodSync(dest, 0o755);
  console.log('[auxd] yt-dlp ready');
}

async function ensureMpv(): Promise<void> {
  const binName = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
  if (isOnPath('mpv') || isInAuxBin(binName)) return;

  if (process.platform === 'darwin') {
    console.error('[auxd] mpv not found. Install it with:');
    console.error('       brew install mpv');
    process.exit(1);
  }

  if (process.platform === 'linux') {
    console.error('[auxd] mpv not found. Install it with your package manager:');
    console.error('       Ubuntu/Debian: sudo apt install mpv');
    console.error('       Arch:          sudo pacman -S mpv');
    console.error('       Fedora:        sudo dnf install mpv');
    process.exit(1);
  }

  if (process.platform === 'win32') {
    console.log('[auxd] downloading mpv...');
    const zipDest = join(AUX_BIN_DIR, 'mpv.7z');
    await downloadFile(MPV_WINDOWS_ZIP_URL, zipDest);
    // Extract mpv.exe using 7zip (must be installed on Windows)
    try {
      execFileSync('7z', ['e', zipDest, 'mpv.exe', `-o${AUX_BIN_DIR}`, '-y'], { stdio: 'ignore' });
      console.log('[auxd] mpv ready');
    } catch {
      console.error('[auxd] mpv downloaded but 7z extraction failed.');
      console.error('       Install 7-Zip from https://www.7-zip.org and re-run auxd.');
      process.exit(1);
    }
    return;
  }

  console.error(`[auxd] mpv not found on ${process.platform}. Install manually: https://mpv.io/installation/`);
  process.exit(1);
}

export async function depsCheck(): Promise<void> {
  await ensureYtDlp();
  await ensureMpv();

  // Prepend ~/.aux/bin to PATH so spawned subprocesses find the downloaded binaries
  process.env['PATH'] = `${AUX_BIN_DIR}:${process.env['PATH'] ?? ''}`;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/aux/src/deps-check.ts
git commit -m "feat(aux): add deps-check — first-run yt-dlp + mpv download"
```

---

## Task 5: Copy daemon source files into packages/aux/src/

**Files:**
- Create: `packages/aux/src/credentials.ts` (copy from daemon — identical to client's)
- Create: `packages/aux/src/ipc-server.ts` (copy from daemon)
- Create: `packages/aux/src/playback-engine.ts` (copy from daemon)
- Create: `packages/aux/src/spotify-client.ts` (copy from daemon)
- Create: `packages/aux/src/ws-client.ts` (copy from daemon)
- Create: `packages/aux/src/youtube-resolver.ts` (copy from daemon)
- Create: `packages/aux/src/yt-cache.ts` (copy from daemon)

These files have no cross-package imports — they only import from Node.js builtins, `ws`, and sibling files in `src/`. No import paths change.

- [ ] **Step 1: Copy files**

```bash
cp packages/daemon/src/credentials.ts packages/aux/src/credentials.ts
cp packages/daemon/src/ipc-server.ts packages/aux/src/ipc-server.ts
cp packages/daemon/src/playback-engine.ts packages/aux/src/playback-engine.ts
cp packages/daemon/src/spotify-client.ts packages/aux/src/spotify-client.ts
cp packages/daemon/src/ws-client.ts packages/aux/src/ws-client.ts
cp packages/daemon/src/youtube-resolver.ts packages/aux/src/youtube-resolver.ts
cp packages/daemon/src/yt-cache.ts packages/aux/src/yt-cache.ts
```

- [ ] **Step 2: Commit**

```bash
git add packages/aux/src/
git commit -m "feat(aux): copy daemon source files into merged package"
```

---

## Task 6: Copy client source files into packages/aux/src/

**Files:**
- Create: `packages/aux/src/App.tsx` (copy from client)
- Create: `packages/aux/src/ipc-client.ts` (copy from client — already imports from `./constants.js` which exists)

`credentials.ts` is identical in both packages and already copied in Task 5.

- [ ] **Step 1: Copy files**

```bash
cp packages/client/src/App.tsx packages/aux/src/App.tsx
cp packages/client/src/ipc-client.ts packages/aux/src/ipc-client.ts
```

- [ ] **Step 2: Commit**

```bash
git add packages/aux/src/App.tsx packages/aux/src/ipc-client.ts
git commit -m "feat(aux): copy client source files into merged package"
```

---

## Task 7: Create packages/aux/bin/auxd.ts

**Files:**
- Create: `packages/aux/bin/auxd.ts`

Based on `packages/daemon/bin/auxd.ts` with three changes:
1. Remove the inline `SERVER_URL` constant and import it from `../src/constants.js`
2. Remove `checkDependencies()` and its call, replace with `depsCheck()` from `../src/deps-check.js`
3. All `../src/` import paths stay the same since the file lives in `bin/`

- [ ] **Step 1: Create bin/auxd.ts**

Create `packages/aux/bin/auxd.ts` with the following content (the full file with the two changes applied):

```ts
#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import type { Socket } from 'node:net';
import { depsCheck } from '../src/deps-check.js';
import { SERVER_URL, PID_FILE } from '../src/constants.js';
import { loadCredentials } from '../src/credentials.js';
import { createWsClient, type WsClientHandle } from '../src/ws-client.js';
import { createIpcServer } from '../src/ipc-server.js';
import { searchYoutube } from '../src/youtube-resolver.js';
import { loadCache, cacheKey } from '../src/yt-cache.js';
import {
  getValidToken,
  startOAuthFlow,
  fetchPlaylists,
  fetchPlaylistTracks,
} from '../src/spotify-client.js';
import { computeDelay, spawnTrack, sendMpvCommand, MPV_IPC_PATH, type TrackProcess } from '../src/playback-engine.js';

await depsCheck();

let currentTrack: TrackProcess | null = null;
let mpvVolume = 60;
const tuiClients = new Set<Socket>();
const ytCache = loadCache();
let isAuthenticated = false;
let currentUsername: string | null = null;
let pendingRoomCreate: string | null = null;
let pendingRoomJoin: string | null = null;
let latestFriendsList: object | null = null;
let latestStateSync: object | null = null;

interface PendingTrack {
  youtubeUrl: string;
  title: string;
  artist: string;
  duration: number;
  socket: Socket;
  roomName: string;
}
let pendingTrackQueue: PendingTrack | null = null;

writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => { currentTrack?.kill(); rmSync(PID_FILE, { force: true }); });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

function broadcast(msg: object): void {
  const line = JSON.stringify(msg) + '\n';
  for (const client of tuiClients) {
    try { client.write(line); } catch { /* client disconnected */ }
  }
}

function replyToSocket(socket: Socket, msg: object): void {
  socket.write(JSON.stringify(msg) + '\n');
}

function startTrack(youtubeUrl: string, startAt: number, ws: WsClientHandle): void {
  if (currentTrack) {
    currentTrack.kill();
    currentTrack = null;
  }
  const delay = computeDelay(startAt, Date.now());
  setTimeout(() => {
    const proc = spawnTrack(youtubeUrl, MPV_IPC_PATH, mpvVolume);
    currentTrack = proc;
    proc.onExit(() => {
      if (currentTrack !== proc) return;
      currentTrack = null;
      ws.send({ event: 'playback:ended' });
    });
  }, delay);
}

async function handleIpcMessage(
  msg: Record<string, unknown>,
  socket: Socket,
  wsClient: WsClientHandle
): Promise<void> {
  if (msg['event'] === 'search') {
    const query = String(msg['query'] ?? '');
    if (!query) {
      replyToSocket(socket, { event: 'search:error', code: 'MISSING_QUERY' });
      return;
    }
    try {
      const results = await searchYoutube(query);
      replyToSocket(socket, { event: 'search:results', results });
    } catch (err) {
      replyToSocket(socket, { event: 'search:error', code: (err as Error).message });
    }
    return;
  }

  if (msg['event'] === 'queue:add') {
    const youtubeUrl = String(msg['youtubeUrl'] ?? '');
    const title = String(msg['title'] ?? '');
    const artist = String(msg['artist'] ?? '');
    const duration = Number(msg['duration'] ?? 0);
    if (!youtubeUrl || !title || !Number.isFinite(duration)) {
      replyToSocket(socket, { event: 'queue:error', code: 'MISSING_FIELDS' });
      return;
    }
    const inRoom = !!(latestStateSync as Record<string, unknown> | null)?.['room'];
    if (inRoom) {
      wsClient.send({ event: 'queue:add', youtubeUrl, title, artist, duration });
      return;
    }
    if (!isAuthenticated || !currentUsername) {
      replyToSocket(socket, { event: 'queue:error', code: 'NOT_IN_ROOM' });
      return;
    }
    const roomName = currentUsername;
    pendingTrackQueue = { youtubeUrl, title, artist, duration, socket, roomName };
    socket.once('end', () => { pendingTrackQueue = null; });
    socket.once('error', () => { pendingTrackQueue = null; });
    wsClient.send({ event: 'room:create', name: roomName });
    return;
  }

  if (msg['event'] === 'volume:up') {
    mpvVolume = Math.min(100, mpvVolume + 5);
    sendMpvCommand(MPV_IPC_PATH, ['set_property', 'volume', mpvVolume]);
    return;
  }

  if (msg['event'] === 'volume:down') {
    mpvVolume = Math.max(0, mpvVolume - 5);
    sendMpvCommand(MPV_IPC_PATH, ['set_property', 'volume', mpvVolume]);
    return;
  }

  if (msg['event'] === 'queue:skip') {
    wsClient.send({ event: 'queue:skip' });
    return;
  }

  if (msg['event'] === 'room:create') {
    const name = String(msg['name'] ?? '');
    if (!name) {
      replyToSocket(socket, { event: 'room:error', code: 'MISSING_FIELDS' });
      return;
    }
    if (isAuthenticated) {
      wsClient.send({ event: 'room:create', name });
    } else {
      pendingRoomCreate = name;
    }
    return;
  }

  if (msg['event'] === 'room:join') {
    const name = String(msg['name'] ?? '');
    if (!name) {
      replyToSocket(socket, { event: 'room:error', code: 'MISSING_FIELDS' });
      return;
    }
    if (isAuthenticated) {
      wsClient.send({ event: 'room:join', name });
    } else {
      pendingRoomJoin = name;
    }
    return;
  }

  if (msg['event'] === 'spotify:playlists') {
    const clientId = process.env['SPOTIFY_CLIENT_ID'] ?? '';
    if (!clientId) {
      replyToSocket(socket, {
        event: 'spotify:error',
        code: 'SPOTIFY_CLIENT_ID_NOT_SET',
        message: 'Set SPOTIFY_CLIENT_ID env var. Create an app at https://developer.spotify.com/dashboard',
      });
      return;
    }
    try {
      let token = await getValidToken(clientId);
      if (!token) {
        token = await startOAuthFlow({
          clientId,
          onUrl: (url) => replyToSocket(socket, { event: 'spotify:auth:url', url }),
        });
        replyToSocket(socket, { event: 'spotify:auth:ok' });
      }
      const playlists = await fetchPlaylists(token.access_token);
      replyToSocket(socket, { event: 'spotify:playlists', playlists });
    } catch (err) {
      replyToSocket(socket, { event: 'spotify:error', code: (err as Error).message });
    }
    return;
  }

  if (msg['event'] === 'spotify:import') {
    const playlistId = String(msg['playlistId'] ?? '');
    if (!playlistId) {
      replyToSocket(socket, { event: 'spotify:error', code: 'MISSING_PLAYLIST_ID' });
      return;
    }
    const clientId = process.env['SPOTIFY_CLIENT_ID'] ?? '';
    if (!clientId) {
      replyToSocket(socket, {
        event: 'spotify:error',
        code: 'SPOTIFY_CLIENT_ID_NOT_SET',
        message: 'Set SPOTIFY_CLIENT_ID env var. Create an app at https://developer.spotify.com/dashboard',
      });
      return;
    }
    const token = await getValidToken(clientId);
    if (!token) {
      replyToSocket(socket, { event: 'spotify:error', code: 'NOT_AUTHENTICATED' });
      return;
    }
    try {
      const spotifyTracks = await fetchPlaylistTracks(token.access_token, playlistId);
      const total = spotifyTracks.length;
      let resolved = 0;
      let failed = 0;
      replyToSocket(socket, { event: 'spotify:import:progress', resolved: 0, total, failed: 0 });

      for (const st of spotifyTracks) {
        const key = cacheKey(st.title, st.artist);
        let youtubeUrl = ytCache.get(key);
        if (youtubeUrl === undefined) {
          try {
            const results = await searchYoutube(`${st.title} ${st.artist}`, 1);
            youtubeUrl = results[0]?.youtubeUrl ?? null;
          } catch {
            youtubeUrl = null;
          }
          ytCache.set(key, youtubeUrl);
        }
        if (youtubeUrl) {
          wsClient.send({ event: 'queue:add', youtubeUrl, title: st.title, artist: st.artist, duration: Math.round(st.durationMs / 1000) });
          resolved++;
        } else {
          failed++;
        }
        replyToSocket(socket, { event: 'spotify:import:progress', resolved, total, failed });
      }
      replyToSocket(socket, { event: 'spotify:import:done', queued: resolved, failed });
    } catch (err) {
      replyToSocket(socket, { event: 'spotify:error', code: (err as Error).message });
    }
    return;
  }
}

const wsClient = createWsClient({
  serverUrl: SERVER_URL,
  onConnected(ws) {
    isAuthenticated = false;
    const creds = loadCredentials();
    if (creds?.token) {
      ws.send(JSON.stringify({ event: 'auth', action: 'token', token: creds.token }));
    } else {
      ws.send(JSON.stringify({ event: 'auth', action: 'guest' }));
    }
  },
  onMessage(msg) {
    broadcast(msg);

    if (msg['event'] === 'state:sync') {
      latestStateSync = msg;
      if (pendingTrackQueue) {
        const { youtubeUrl, title, artist, duration } = pendingTrackQueue;
        pendingTrackQueue = null;
        wsClient.send({ event: 'queue:add', youtubeUrl, title, artist, duration });
      }
    }

    if (msg['event'] === 'queue:update' && latestStateSync) {
      const snap = latestStateSync as Record<string, unknown>;
      latestStateSync = { ...snap, room: { ...(snap['room'] as Record<string, unknown>), queue: msg['queue'] } };
    }

    if (msg['event'] === 'playback:next' && latestStateSync) {
      const snap = latestStateSync as Record<string, unknown>;
      latestStateSync = {
        ...snap,
        room: {
          ...(snap['room'] as Record<string, unknown>),
          nowPlaying: msg['track'],
          playbackStartedAt: msg['startAt'],
        },
      };
    }

    if (msg['event'] === 'room:error' && pendingTrackQueue) {
      const code = String(msg['code'] ?? '');
      if (code === 'ROOM_NAME_TAKEN') {
        wsClient.send({ event: 'room:join', name: pendingTrackQueue.roomName });
      } else {
        replyToSocket(pendingTrackQueue.socket, { event: 'queue:error', code });
        pendingTrackQueue = null;
      }
    }

    if (msg['event'] === 'auth:ok') {
      isAuthenticated = true;
      currentUsername = String(msg['username'] ?? '') || null;
      wsClient.send({ event: 'friend:list' });
      if (pendingRoomCreate) {
        wsClient.send({ event: 'room:create', name: pendingRoomCreate });
        pendingRoomCreate = null;
      }
      if (pendingRoomJoin) {
        wsClient.send({ event: 'room:join', name: pendingRoomJoin });
        pendingRoomJoin = null;
      }
    }

    if (msg['event'] === 'auth:error') {
      pendingRoomCreate = null;
      pendingRoomJoin = null;
    }

    if (msg['event'] === 'friends:list') {
      latestFriendsList = msg;
    }

    if (msg['event'] === 'playback:next') {
      const track = msg['track'];
      if (typeof track !== 'object' || track === null) return;
      const youtubeUrl = String((track as Record<string, unknown>)['youtubeUrl'] ?? '');
      const startAt = Number(msg['startAt']);
      if (youtubeUrl && Number.isFinite(startAt)) {
        startTrack(youtubeUrl, startAt, wsClient);
      }
    }
  },
});

createIpcServer({
  onConnection(socket) {
    tuiClients.add(socket);
    if (latestStateSync) {
      const replay = { ...(latestStateSync as Record<string, unknown>), replay: true };
      socket.write(JSON.stringify(replay) + '\n');
    }
    if (latestFriendsList) {
      socket.write(JSON.stringify(latestFriendsList) + '\n');
    }
    socket.on('end', () => tuiClients.delete(socket));
    socket.on('error', () => tuiClients.delete(socket));
    socket.on('message', (msg: Record<string, unknown>) => {
      handleIpcMessage(msg, socket, wsClient).catch((err: Error) => {
        console.error('[daemon] IPC handler error:', err.message);
      });
    });
  },
});

console.log(`[auxd] running (pid ${process.pid})`);
```

- [ ] **Step 2: Commit**

```bash
git add packages/aux/bin/auxd.ts
git commit -m "feat(aux): add auxd entry point — imports SERVER_URL, calls depsCheck"
```

---

## Task 8: Create packages/aux/bin/aux.ts

**Files:**
- Create: `packages/aux/bin/aux.ts`

Based on `packages/client/bin/aux.ts` with three changes:
1. Remove the inline `SERVER_URL` constant — import from `../src/constants.js`
2. Update `DAEMON_BIN` path: both aux.ts and auxd.ts are now in the same `bin/` directory
3. Handle dev (tsx) vs production (node) when spawning the daemon

- [ ] **Step 1: Create bin/aux.ts**

```ts
#!/usr/bin/env node
import { WebSocket } from 'ws';
import { readFileSync, existsSync } from 'node:fs';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveCredentials, loadCredentials } from '../src/credentials.js';
import { IPC_PATH, PID_FILE, SERVER_URL } from '../src/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const isDev = __filename.endsWith('.ts');
const DAEMON_FILE = resolve(__dirname, isDev ? 'auxd.ts' : 'auxd.js');

const [,, command, ...args] = process.argv;

async function main(): Promise<void> {
  if (command === 'register') {
    const [username, password] = args;
    if (!username || !password) {
      console.error('Usage: aux register <username> <password>');
      process.exit(1);
    }
    await authCommand('register', username, password);
    return;
  }

  if (command === 'login') {
    const [username, password] = args;
    if (!username || !password) {
      console.error('Usage: aux login <username> <password>');
      process.exit(1);
    }
    await authCommand('login', username, password);
    return;
  }

  if (command === 'create') {
    const [name] = args;
    if (!name) {
      console.error('Usage: aux create <name>');
      process.exit(1);
    }
    if (!loadCredentials()) {
      console.error('Guests cannot create rooms. Register first: aux register <username> <password>');
      process.exit(1);
    }
    await daemonRoomCommand('room:create', name);
    return;
  }

  if (command === 'join') {
    const [name] = args;
    if (!name) {
      console.error('Usage: aux join <name>');
      process.exit(1);
    }
    await daemonRoomCommand('room:join', name);
    return;
  }

  if (command === 'quit') {
    if (!existsSync(PID_FILE)) {
      console.log('Daemon is not running.');
      return;
    }
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    process.kill(pid, 'SIGTERM');
    console.log('Daemon stopped.');
    return;
  }

  if (command === 'friend') {
    const [subcommand, username] = args;
    if (subcommand !== 'add' || !username) {
      console.error('Usage: aux friend add <username>');
      process.exit(1);
    }
    await friendAddCommand(username);
    return;
  }

  if (command !== undefined) {
    console.error(`Unknown command: ${command}`);
    console.error('Available commands: register, login, create, join, quit, friend');
    process.exit(1);
  }

  await ensureDaemon();
  const { render } = await import('ink');
  const { createElement } = await import('react');
  const { default: App } = await import('../src/App.js');
  const { waitUntilExit } = render(createElement(App));
  await waitUntilExit();
}

async function authCommand(action: 'register' | 'login', username: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL);
    ws.on('open', () => {
      ws.send(JSON.stringify({ event: 'auth', action, username, password }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (msg['event'] === 'auth:ok') {
        saveCredentials({ token: msg['token'] as string, username: msg['username'] as string });
        console.log(`Logged in as ${msg['username'] as string}`);
        ws.close();
        resolve();
      } else if (msg['event'] === 'auth:error') {
        console.error(`Error: ${msg['code'] as string}`);
        ws.close();
        reject(new Error(msg['code'] as string));
      }
    });
    ws.on('error', reject);
  });
}

async function daemonRoomCommand(event: 'room:create' | 'room:join', name: string): Promise<void> {
  await ensureDaemon();
  return new Promise((resolve, reject) => {
    const socket = connect(IPC_PATH);
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('Timed out waiting for room response'));
    }, 10000);
    function settle(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    }
    socket.once('connect', () => {
      socket.write(JSON.stringify({ event, name }) + '\n');
    });
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg['event'] === 'state:sync') {
            if (msg['replay']) continue;
            const room = msg['room'] as Record<string, unknown>;
            const members = (room['members'] as Array<{ username: string }>)
              .map((m) => m.username)
              .join(', ');
            console.log(`Room: ${room['name'] as string} (members: ${members})`);
            settle(resolve);
          } else if (msg['event'] === 'room:error' || msg['event'] === 'auth:error') {
            const code = msg['code'] as string;
            console.error(`Error: ${code}`);
            settle(() => reject(new Error(code)));
          }
        } catch { /* ignore parse errors */ }
      }
    });
    socket.on('error', (err) => settle(() => reject(err)));
  });
}

async function friendAddCommand(username: string): Promise<void> {
  const creds = loadCredentials();
  if (!creds) {
    console.error('Not logged in. Run: aux login <username> <password>');
    process.exit(1);
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL);
    ws.on('open', () => {
      ws.send(JSON.stringify({ event: 'auth', action: 'token', token: creds.token }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (msg['event'] === 'auth:ok') {
        ws.send(JSON.stringify({ event: 'friend:add', username }));
        return;
      }
      if (msg['event'] === 'friends:list') {
        const friends = msg['friends'] as Array<{ username: string; status: string; roomName: string | null }>;
        const friend = friends.find((f) => f.username === username);
        if (friend?.status === 'online') {
          const room = friend.roomName ? ` in room: ${friend.roomName}` : '';
          console.log(`Added ${username} as a friend. They are online${room}.`);
        } else {
          console.log(`Added ${username} as a friend.`);
        }
        ws.close();
        resolve();
        return;
      }
      if (msg['event'] === 'friend:error' || msg['event'] === 'auth:error') {
        console.error(`Error: ${msg['code'] as string}`);
        ws.close();
        reject(new Error(msg['code'] as string));
      }
    });
    ws.on('error', reject);
  });
}

function isDaemonRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ensureDaemon(): Promise<void> {
  if (!isDaemonRunning()) {
    const child = isDev
      ? spawn('npx', ['tsx', DAEMON_FILE], { detached: true, stdio: 'ignore', env: { ...process.env } })
      : spawn('node', [DAEMON_FILE], { detached: true, stdio: 'ignore', env: { ...process.env } });
    child.unref();
  }
  await waitForSocket(IPC_PATH, 5000);
}

async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const available = await new Promise<boolean>((resolve) => {
      const s = connect(path);
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    if (available) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Daemon did not open /tmp/aux.sock within 5s — run: aux quit && aux to restart');
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add packages/aux/bin/aux.ts
git commit -m "feat(aux): add aux entry point — imports SERVER_URL, unified DAEMON_BIN path"
```

---

## Task 9: Verify build

**Files:** none created — verification only

- [ ] **Step 1: Install workspace dependencies**

```bash
npm install
```

- [ ] **Step 2: Build packages/aux**

```bash
npm run build --workspace=packages/aux
```

Expected: no TypeScript errors. `packages/aux/dist/` directory created with `bin/aux.js`, `bin/auxd.js`, and all `src/` files compiled.

- [ ] **Step 3: Smoke-test dev mode (requires server running + yt-dlp/mpv installed locally)**

```bash
# Start server in one terminal
npm run dev:server

# In another terminal — verify auxd starts (it will fail on SERVER_URL since it's a placeholder)
cd packages/aux && npx tsx bin/auxd.ts
```

Expected: `[auxd] running (pid XXXX)` printed, then a reconnect loop (since `wss://aux.yourdomain.com` is a placeholder — this is expected).

- [ ] **Step 4: Fix any TypeScript errors before proceeding**

If `tsc` reports errors, fix them now. Common issues:
- Missing type imports: add `import type { ... }` as needed
- `execFileSync` used in `deps-check.ts` on Windows `which` fallback: use `where` instead of `which` on `win32`

Update `deps-check.ts` `isOnPath` for Windows compatibility:
```ts
function isOnPath(bin: string): boolean {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(cmd, [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Commit fixed build**

```bash
git add packages/aux/
git commit -m "fix(aux): resolve TypeScript errors in merged package"
```

---

## Task 10: Delete old packages

**Files:**
- Delete: `packages/client/` (entire directory)
- Delete: `packages/daemon/` (entire directory)

Only do this after Task 9 passes. The old packages are no longer in the workspaces array (updated in Task 2) but their directories still exist.

- [ ] **Step 1: Remove old package directories**

```bash
rm -rf packages/client packages/daemon
```

- [ ] **Step 2: Re-install to clean up node_modules symlinks**

```bash
npm install
```

- [ ] **Step 3: Verify build still passes**

```bash
npm run build --workspace=packages/aux
```

Expected: clean compile, no references to deleted packages.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(aux): remove packages/client and packages/daemon (merged into packages/aux)"
```

---

## Task 11: Server auto-start service scripts

**Files:**
- Create: `scripts/install-service.sh`
- Create: `scripts/install-service.ps1`

These scripts register the aux server to start on boot. They must be run once on the host machine.

- [ ] **Step 1: Create scripts/install-service.sh**

```bash
mkdir -p scripts
```

Create `scripts/install-service.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(which node)"
ENV_FILE="$REPO_DIR/packages/server/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Error: $ENV_FILE not found. Copy .env.example and fill in JWT_SECRET."
  exit 1
fi

if [[ "$(uname)" == "Darwin" ]]; then
  PLIST="$HOME/Library/LaunchAgents/com.aux.server.plist"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.aux.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO_DIR/packages/server/dist/src/server.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/.aux/server.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.aux/server.error.log</string>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR/packages/server</string>
  <key>EnvironmentVariables</key>
  <dict>
    $(while IFS='=' read -r key val; do
      [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
      echo "<key>$key</key><string>$val</string>"
    done < "$ENV_FILE")
  </dict>
</dict>
</plist>
PLIST
  launchctl load "$PLIST"
  echo "aux server registered as launchd service: com.aux.server"
  echo "Logs: ~/.aux/server.log"

elif command -v systemctl &>/dev/null; then
  SERVICE_FILE="$HOME/.config/systemd/user/aux-server.service"
  mkdir -p "$(dirname "$SERVICE_FILE")"
  cat > "$SERVICE_FILE" <<SERVICE
[Unit]
Description=aux music server
After=network.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR/packages/server
ExecStart=$NODE_BIN $REPO_DIR/packages/server/dist/src/server.js
EnvironmentFile=$ENV_FILE
Restart=always
RestartSec=3
StandardOutput=append:$HOME/.aux/server.log
StandardError=append:$HOME/.aux/server.error.log

[Install]
WantedBy=default.target
SERVICE
  systemctl --user daemon-reload
  systemctl --user enable aux-server
  systemctl --user start aux-server
  echo "aux server registered as systemd user service: aux-server"
  echo "Status: systemctl --user status aux-server"

else
  echo "Unsupported platform. Install the server as a service manually."
  exit 1
fi
```

- [ ] **Step 2: Create scripts/install-service.ps1**

Create `scripts/install-service.ps1`:

```powershell
$ErrorActionPreference = "Stop"

$RepoDir = Split-Path -Parent $PSScriptRoot
$NodeBin = (Get-Command node).Source
$EnvFile = "$RepoDir\packages\server\.env"
$ServerScript = "$RepoDir\packages\server\dist\src\server.js"

if (-not (Test-Path $EnvFile)) {
    Write-Error "Missing $EnvFile. Copy .env.example and fill in JWT_SECRET."
    exit 1
}

# Load .env into a hashtable
$envVars = @{}
Get-Content $EnvFile | ForEach-Object {
    if ($_ -match '^([^#][^=]*)=(.*)$') {
        $envVars[$Matches[1].Trim()] = $Matches[2].Trim()
    }
}

$envString = ($envVars.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`n"
$action = New-ScheduledTaskAction -Execute $NodeBin -Argument $ServerScript -WorkingDirectory "$RepoDir\packages\server"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Hours 0)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest

Register-ScheduledTask -TaskName "aux-server" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force
Write-Host "aux server registered as a Task Scheduler task: aux-server"
Write-Host "It will start on next login. To start now: Start-ScheduledTask -TaskName aux-server"
```

- [ ] **Step 3: Make shell script executable**

```bash
chmod +x scripts/install-service.sh
```

- [ ] **Step 4: Build server for production use in scripts**

The service scripts run `dist/src/server.js`, so the server must be built first:

```bash
npm run build --workspace=packages/server
```

Expected: `packages/server/dist/` created with compiled JS.

- [ ] **Step 5: Commit**

```bash
git add scripts/install-service.sh scripts/install-service.ps1
git commit -m "feat(server): add install-service scripts for macOS launchd, Linux systemd, Windows Task Scheduler"
```

---

## Self-Review Checklist

- [x] **Spec: Merge daemon + client → packages/aux** — Tasks 2, 5, 6, 7, 8, 10
- [x] **Spec: SERVER_URL baked into constants.ts** — Task 3
- [x] **Spec: yt-dlp auto-download all platforms** — Task 4
- [x] **Spec: mpv auto-download Windows, hint macOS/Linux** — Task 4
- [x] **Spec: Server binds 0.0.0.0** — Task 1
- [x] **Spec: .env.example** — Task 1
- [x] **Spec: Server auto-start service scripts** — Task 11
- [x] **Root package.json workspaces update** — Task 2
- [x] **Build verification** — Task 9
- [x] **isOnPath Windows compatibility (`where` vs `which`)** — Task 9 fix step
