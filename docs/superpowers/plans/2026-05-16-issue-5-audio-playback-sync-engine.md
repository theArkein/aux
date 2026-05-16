# Audio Playback + Sync Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement synchronized audio playback across all daemons in a room, with a live now-playing panel, volume control, and track auto-advance.

**Architecture:** The server already emits `playback:next { track, startAt }` with a `startAt` timestamp 200ms in the future — all daemons in the room receive this simultaneously and use `computeDelay(startAt, Date.now())` to sleep before spawning `yt-dlp | mpv`. When mpv exits, the daemon sends `playback:ended` to the server, which auto-advances the queue. The TUI renders a live progress bar by polling elapsed time with `setInterval`.

**Tech Stack:** Node.js child_process (spawn), yt-dlp CLI, mpv CLI + IPC socket (`/tmp/auxmpv.sock`), Ink + React hooks for TUI, Node.js `node:test` for unit tests.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `packages/daemon/src/playback-engine.ts` | Pure sync helpers (`computeDelay`) + process spawning (`spawnTrack`, `sendMpvCommand`) |
| Create | `packages/daemon/__tests__/playback-engine.test.ts` | Unit tests for sync-engine timestamp coordination using simulated clock |
| Modify | `packages/daemon/bin/auxd.ts` | Wire `playback:next` → spawn track, `volume:up`/`volume:down` IPC → mpv volume |
| Modify | `packages/client/src/App.tsx` | Now-playing panel with progress bar, volume keys |

---

### Task 1: Sync-engine pure functions + tests

**Files:**
- Create: `packages/daemon/src/playback-engine.ts`
- Create: `packages/daemon/__tests__/playback-engine.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/daemon/__tests__/playback-engine.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDelay } from '../src/playback-engine.js';

test('computeDelay returns positive ms when startAt is in the future', () => {
  assert.equal(computeDelay(1200, 1000), 200);
});

test('computeDelay returns 0 when startAt is in the past', () => {
  assert.equal(computeDelay(1000, 2000), 0);
});

test('computeDelay returns 0 when startAt equals now', () => {
  assert.equal(computeDelay(1000, 1000), 0);
});

test('computeDelay handles large future gaps', () => {
  assert.equal(computeDelay(5000, 1000), 4000);
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd packages/daemon && npx tsx --test '__tests__/playback-engine.test.ts'
```

Expected: error — `Cannot find module '../src/playback-engine.js'`

- [ ] **Step 3: Implement `computeDelay`**

Create `packages/daemon/src/playback-engine.ts`:

```typescript
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';

export const MPV_IPC_PATH = '/tmp/auxmpv.sock';

export function computeDelay(startAt: number, now: number): number {
  return Math.max(0, startAt - now);
}

export interface TrackProcess {
  kill(): void;
  onExit(cb: () => void): void;
}

export function spawnTrack(youtubeUrl: string, ipcPath = MPV_IPC_PATH): TrackProcess {
  const proc = spawn(
    'sh',
    ['-c', `yt-dlp -f bestaudio -q -o - '${youtubeUrl}' | mpv --no-terminal --idle=no --input-ipc-server=${ipcPath} -`],
    { stdio: 'ignore' }
  );
  return {
    kill() { proc.kill('SIGTERM'); },
    onExit(cb) { proc.on('exit', cb); },
  };
}

export function sendMpvCommand(ipcPath: string, command: unknown[]): void {
  const sock = createConnection(ipcPath);
  sock.on('connect', () => {
    sock.write(JSON.stringify({ command }) + '\n');
    sock.end();
  });
  sock.on('error', () => { /* mpv may not be ready yet — silently ignore */ });
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd packages/daemon && npx tsx --test '__tests__/playback-engine.test.ts'
```

Expected output (all 4 tests pass):
```
✔ computeDelay returns positive ms when startAt is in the future
✔ computeDelay returns 0 when startAt is in the past
✔ computeDelay returns 0 when startAt equals now
✔ computeDelay handles large future gaps
```

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/playback-engine.ts packages/daemon/__tests__/playback-engine.test.ts
git commit -m "feat(daemon): sync-engine computeDelay + spawnTrack + sendMpvCommand"
```

---

### Task 2: Wire playback in the daemon

**Files:**
- Modify: `packages/daemon/bin/auxd.ts`

The daemon's `onMessage` already broadcasts every server message to TUI clients. We extend it to intercept `playback:next` and spawn audio, and add IPC handler for volume keys.

- [ ] **Step 1: Replace `packages/daemon/bin/auxd.ts` with the updated version**

```typescript
#!/usr/bin/env tsx
import { writeFileSync, rmSync } from 'node:fs';
import type { Socket } from 'node:net';
import { loadCredentials } from '../src/credentials.js';
import { createWsClient, type WsClientHandle } from '../src/ws-client.js';
import { createIpcServer } from '../src/ipc-server.js';
import { searchYoutube } from '../src/youtube-resolver.js';
import { computeDelay, spawnTrack, sendMpvCommand, MPV_IPC_PATH, type TrackProcess } from '../src/playback-engine.js';

const PID_FILE = '/tmp/aux.pid';
const SERVER_URL = process.env['AUX_SERVER_URL'] ?? 'ws://localhost:3000';

let currentTrack: TrackProcess | null = null;
let mpvVolume = 60;
const tuiClients = new Set<Socket>();

writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => rmSync(PID_FILE, { force: true }));
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
    const proc = spawnTrack(youtubeUrl);
    currentTrack = proc;
    // Set initial volume after a short delay to allow mpv IPC socket to be ready
    setTimeout(() => sendMpvCommand(MPV_IPC_PATH, ['set_property', 'volume', mpvVolume]), 500);
    proc.onExit(() => {
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
    wsClient.send({ event: 'queue:add', youtubeUrl, title, artist, duration });
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
}

const wsClient = createWsClient({
  serverUrl: SERVER_URL,
  onConnected(ws) {
    const creds = loadCredentials();
    if (creds?.token) {
      ws.send(JSON.stringify({ event: 'auth', action: 'token', token: creds.token }));
    }
  },
  onMessage(msg) {
    broadcast(msg);

    if (msg['event'] === 'playback:next') {
      const track = msg['track'] as Record<string, unknown>;
      const youtubeUrl = String(track['youtubeUrl'] ?? '');
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

- [ ] **Step 2: Verify TypeScript compiles with no errors**

```bash
cd packages/daemon && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Run all daemon tests**

```bash
cd packages/daemon && npx tsx --test '__tests__/**/*.test.ts'
```

Expected: all tests pass (credentials, youtube-resolver, playback-engine).

- [ ] **Step 4: Commit**

```bash
git add packages/daemon/bin/auxd.ts
git commit -m "feat(daemon): wire playback:next → yt-dlp|mpv spawn and volume:up/down IPC"
```

---

### Task 3: TUI now-playing panel with progress bar and volume keys

**Files:**
- Modify: `packages/client/src/App.tsx`

The TUI already receives all server events via the daemon's broadcast. We add state for the currently playing track, a 1-second ticker for progress, and volume key handlers.

- [ ] **Step 1: Replace `packages/client/src/App.tsx` with the updated version**

```typescript
import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { createIpcClient, type IpcClientHandle } from './ipc-client.js';

type PanelId = 'nowPlaying' | 'queue' | 'members';
const PANELS: PanelId[] = ['nowPlaying', 'queue', 'members'];

interface Member { id: string; username: string; }

interface Track {
  id: string;
  title: string;
  artist: string;
  duration: number;
  queuedBy: string;
}

interface RoomState {
  name: string;
  members: Member[];
  queue: Track[];
  nowPlaying: Track | null;
  playbackStartedAt: number | null;
}

interface PlaybackState {
  track: Track;
  startAt: number;
}

interface SearchResult {
  title: string;
  artist: string;
  duration: number;
  youtubeUrl: string;
}

type Mode = 'normal' | 'typing' | 'results';

interface PanelBoxProps {
  title: string;
  focused: boolean;
  children: React.ReactNode;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function progressBar(elapsed: number, duration: number, width = 20): string {
  const ratio = duration > 0 ? Math.min(1, elapsed / duration) : 0;
  const filled = Math.floor(ratio * width);
  return '='.repeat(filled) + ' '.repeat(width - filled);
}

function PanelBox({ title, focused, children }: PanelBoxProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? 'cyan' : 'gray'} paddingX={1} width={34} minHeight={10}>
      <Text bold color={focused ? 'cyan' : undefined}>{title}</Text>
      <Box marginTop={1} flexDirection="column">{children}</Box>
    </Box>
  );
}

export default function App(): React.ReactElement {
  const { exit } = useApp();
  const [focused, setFocused] = useState<PanelId>('nowPlaying');
  const [room, setRoom] = useState<RoomState | null>(null);
  const [playback, setPlayback] = useState<PlaybackState | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [mode, setMode] = useState<Mode>('normal');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const clientRef = useRef<IpcClientHandle | null>(null);

  useEffect(() => {
    const client = createIpcClient({
      onMessage(msg) {
        const m = msg as Record<string, unknown>;

        if (m['event'] === 'state:sync' && m['room']) {
          const r = m['room'] as RoomState;
          setRoom(r);
          if (r.nowPlaying && r.playbackStartedAt) {
            setPlayback({ track: r.nowPlaying, startAt: r.playbackStartedAt });
          }
        }

        if (m['event'] === 'queue:update' && Array.isArray(m['queue'])) {
          setRoom((prev) => prev ? { ...prev, queue: m['queue'] as Track[] } : prev);
        }

        if (m['event'] === 'playback:next') {
          const track = m['track'] as Track;
          const startAt = Number(m['startAt']);
          setPlayback({ track, startAt });
          setElapsed(0);
          setRoom((prev) => prev ? { ...prev, nowPlaying: track } : prev);
        }

        if (m['event'] === 'search:results' && Array.isArray(m['results'])) {
          setResults(m['results'] as SearchResult[]);
          setSelectedIdx(0);
          setMode('results');
        }

        if (m['event'] === 'search:error') {
          setMode('normal');
          setQuery('');
        }
      },
      onEnd: exit,
      onError: (err) => { process.stderr.write(err.message + '\n'); exit(); },
    });
    clientRef.current = client;
    return () => { client.close(); };
  }, [exit]);

  // Progress ticker — fires every second while something is playing
  useEffect(() => {
    if (!playback) { setElapsed(0); return; }
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - playback.startAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [playback]);

  useInput((input, key) => {
    if (mode === 'normal') {
      if (input === 'q') { exit(); return; }
      if (key.tab) {
        const idx = PANELS.indexOf(focused);
        setFocused(PANELS[(idx + 1) % PANELS.length]!);
        return;
      }
      if (input === 's') {
        setQuery('');
        setResults([]);
        setMode('typing');
        return;
      }
      if (input === '+' || input === '=') {
        clientRef.current?.send({ event: 'volume:up' });
        return;
      }
      if (input === '-') {
        clientRef.current?.send({ event: 'volume:down' });
        return;
      }
    }

    if (mode === 'typing') {
      if (key.escape) { setMode('normal'); setQuery(''); return; }
      if (key.return) {
        if (query.trim()) {
          clientRef.current?.send({ event: 'search', query: query.trim() });
        }
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setQuery((q) => q + input);
      }
      return;
    }

    if (mode === 'results') {
      if (key.escape) { setMode('normal'); setResults([]); setQuery(''); return; }
      if (key.upArrow) { setSelectedIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setSelectedIdx((i) => Math.min(results.length - 1, i + 1)); return; }
      if (key.return) {
        const track = results[selectedIdx];
        if (track) {
          clientRef.current?.send({
            event: 'queue:add',
            youtubeUrl: track.youtubeUrl,
            title: track.title,
            artist: track.artist,
            duration: track.duration,
          });
          setMode('normal');
          setResults([]);
          setQuery('');
        }
        return;
      }
    }
  });

  const searchOverlay = mode === 'typing' || mode === 'results';
  const clampedElapsed = playback ? Math.min(elapsed, playback.track.duration) : 0;

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>aux</Text>
        {room && <Text dimColor>  room: {room.name}</Text>}
      </Box>

      {searchOverlay ? (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold color="cyan">Search: </Text>
            <Text>{query}{mode === 'typing' ? '█' : ''}</Text>
          </Box>
          {mode === 'results' && results.length === 0 && (
            <Text dimColor>No results</Text>
          )}
          {mode === 'results' && results.map((r, i) => (
            <Box key={r.youtubeUrl}>
              <Text color={i === selectedIdx ? 'cyan' : undefined}>
                {i === selectedIdx ? '▶ ' : '  '}
                {r.title} — {r.artist} ({formatDuration(r.duration)})
              </Text>
            </Box>
          ))}
          <Box marginTop={1}>
            <Text dimColor>
              {mode === 'typing' ? 'Enter: search  Esc: cancel' : '↑↓: navigate  Enter: queue  Esc: cancel'}
            </Text>
          </Box>
        </Box>
      ) : (
        <>
          <Box gap={1}>
            <PanelBox title="Now Playing" focused={focused === 'nowPlaying'}>
              {playback ? (
                <Box flexDirection="column">
                  <Text>{playback.track.title}</Text>
                  <Text dimColor>{playback.track.artist}</Text>
                  <Box marginTop={1}>
                    <Text>[{progressBar(clampedElapsed, playback.track.duration)}]</Text>
                  </Box>
                  <Text dimColor>
                    {formatDuration(clampedElapsed)} / {formatDuration(playback.track.duration)}
                  </Text>
                </Box>
              ) : (
                <Text dimColor>{room ? 'Nothing playing' : 'Not in a room'}</Text>
              )}
            </PanelBox>
            <PanelBox title="Queue" focused={focused === 'queue'}>
              {room && room.queue.length > 0
                ? room.queue.map((t) => (
                    <Text key={t.id}>
                      {t.title}
                      {t.duration ? ` (${formatDuration(t.duration)})` : ''}
                      {` · ${t.queuedBy}`}
                    </Text>
                  ))
                : <Text dimColor>Queue is empty</Text>}
            </PanelBox>
            <PanelBox title="Members" focused={focused === 'members'}>
              {room && room.members.length > 0
                ? room.members.map((m) => <Text key={m.id}>{m.username}</Text>)
                : <Text dimColor>No members</Text>}
            </PanelBox>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Tab: switch panel  ·  s: search  ·  +/-: volume  ·  q: quit TUI</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles with no errors**

```bash
cd packages/client && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Run all server tests to confirm no regressions**

```bash
cd packages/server && npx tsx --test '__tests__/**/*.test.ts'
```

Expected: all tests pass.

- [ ] **Step 4: Run all daemon tests to confirm no regressions**

```bash
cd packages/daemon && npx tsx --test '__tests__/**/*.test.ts'
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/App.tsx
git commit -m "feat(client): now-playing panel with progress bar and volume control"
```

---

## Self-Review

### Spec coverage check

| Acceptance criterion | Task covering it |
|---|---|
| Server emits `playback:next` when queue is non-empty | Already done — `ws-handler.ts` + `ws-playback.test.ts` ✅ |
| All daemons begin playback within 200ms | Task 2 — `startTrack` uses `computeDelay(startAt, Date.now())` ✅ |
| Now-playing panel shows title, artist, progress bar, duration | Task 3 — `PanelBox` + progress bar ✅ |
| Volume control (up/down) adjusts mpv | Task 2 (`volume:up`/`down` IPC) + Task 3 (`+`/`-` keys) ✅ |
| Track ending → server advances to next | Task 2 — `proc.onExit(() => ws.send({ event: 'playback:ended' }))` ✅ |
| Unit tests for sync-engine timestamp coordination | Task 1 — 4 tests with simulated `now` arg ✅ |

### Placeholder scan

No TBD, TODO, "similar to", or "add appropriate" patterns found.

### Type consistency

- `TrackProcess` defined in Task 1 (`playback-engine.ts`), used in Task 2 (`auxd.ts`) as `currentTrack: TrackProcess | null` ✅
- `PlaybackState` defined in Task 3 (`App.tsx`) as `{ track: Track; startAt: number }` ✅
- `Track` interface matches server type: `id, title, artist, duration, queuedBy` ✅
- `RoomState` extended with `nowPlaying: Track | null` and `playbackStartedAt: number | null` — consistent with server `Room` type ✅
- `sendMpvCommand` called with `['set_property', 'volume', mpvVolume]` in Task 2 — matches the function signature `command: unknown[]` ✅
