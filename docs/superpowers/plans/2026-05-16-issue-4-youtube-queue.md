# Issue #4: YouTube Search + Queue a Track — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the TUI, users type a search query; `yt-dlp` resolves results; the user selects a track; the server appends it to the room queue and broadcasts `queue:update` to all members.

**Architecture:** `youtube-resolver` module lives in the daemon (owns audio/subprocess logic). Daemon forwards IPC `search` messages to yt-dlp, returns results to TUI. TUI sends `queue:add` IPC message → daemon forwards to server → server appends track → broadcasts `queue:update` → daemon relays to all TUI clients.

**Tech Stack:** `yt-dlp` subprocess via `node:child_process`, TypeScript strict, `node:test` + `assert/strict`, Ink v5 useInput for TUI

---

## File Map

| Action | Path |
|--------|------|
| Modify | `packages/server/src/types.ts` |
| Modify | `packages/server/src/rooms.ts` |
| Create | `packages/server/src/queue.ts` |
| Modify | `packages/server/src/ws-handler.ts` |
| Create | `packages/server/__tests__/queue.test.ts` |
| Create | `packages/server/__tests__/ws-queue.test.ts` |
| Create | `packages/daemon/src/youtube-resolver.ts` |
| Modify | `packages/daemon/bin/auxd.ts` |
| Create | `packages/daemon/__tests__/youtube-resolver.test.ts` |
| Modify | `packages/client/src/App.tsx` |

---

### Task 1: Extend Server Types — Track + queue field on Room

**Files:**
- Modify: `packages/server/src/types.ts`
- Modify: `packages/server/src/rooms.ts`

- [ ] **Step 1: Add Track interface and queue to Room in types.ts**

Replace the existing `Room` interface (add `queue: Track[]`):

```typescript
export interface User {
  id: string;
  username: string;
}

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: number;
}

export interface Member {
  id: string;
  username: string;
}

export interface Track {
  id: string;
  youtubeUrl: string;
  title: string;
  artist: string;
  duration: number; // seconds
  queuedBy: string; // userId
}

export interface Room {
  id: string;
  name: string;
  hostId: string;
  members: Member[];
  queue: Track[];
  createdAt: number;
}
```

- [ ] **Step 2: Initialize queue in createRoom (rooms.ts)**

In `packages/server/src/rooms.ts`, update the `createRoom` function — add `queue: []` to the room object literal:

```typescript
const room: Room = {
  id: randomUUID(),
  name,
  hostId: host.id,
  members: [{ id: host.id, username: host.username }],
  queue: [],
  createdAt: Date.now(),
};
```

- [ ] **Step 3: Verify existing server tests still pass**

```bash
npm test --workspace=packages/server
```

Expected: all existing tests pass (rooms + auth + WS tests).

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/types.ts packages/server/src/rooms.ts
git commit -m "feat(server): add Track type and queue field to Room"
```

---

### Task 2: Server Queue Operations Module

**Files:**
- Create: `packages/server/src/queue.ts`
- Modify: `packages/server/src/ws-handler.ts`

- [ ] **Step 1: Write failing test for addTrack**

Create `packages/server/__tests__/queue.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Room } from '../src/types.js';
import { addTrack } from '../src/queue.js';

function makeRoom(): Room {
  return {
    id: 'r1',
    name: 'lounge',
    hostId: 'u1',
    members: [{ id: 'u1', username: 'alice' }],
    queue: [],
    createdAt: Date.now(),
  };
}

test('addTrack appends track and returns it', () => {
  const room = makeRoom();
  const track = addTrack(room, {
    youtubeUrl: 'https://youtube.com/watch?v=abc',
    title: 'Harder Better Faster',
    artist: 'Daft Punk',
    duration: 224,
    queuedBy: 'u1',
  });
  assert.equal(room.queue.length, 1);
  assert.equal(track.title, 'Harder Better Faster');
  assert.ok(track.id, 'track has id');
});

test('addTrack assigns unique ids', () => {
  const room = makeRoom();
  const t1 = addTrack(room, { youtubeUrl: 'https://youtube.com/watch?v=a', title: 'A', artist: 'X', duration: 100, queuedBy: 'u1' });
  const t2 = addTrack(room, { youtubeUrl: 'https://youtube.com/watch?v=b', title: 'B', artist: 'X', duration: 200, queuedBy: 'u1' });
  assert.notEqual(t1.id, t2.id);
  assert.equal(room.queue.length, 2);
});

test('addTrack throws MISSING_FIELDS if youtubeUrl empty', () => {
  const room = makeRoom();
  assert.throws(
    () => addTrack(room, { youtubeUrl: '', title: 'A', artist: 'X', duration: 100, queuedBy: 'u1' }),
    /MISSING_FIELDS/
  );
});

test('addTrack throws MISSING_FIELDS if title empty', () => {
  const room = makeRoom();
  assert.throws(
    () => addTrack(room, { youtubeUrl: 'https://youtube.com/watch?v=a', title: '', artist: 'X', duration: 100, queuedBy: 'u1' }),
    /MISSING_FIELDS/
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/server 2>&1 | grep -A3 "queue.test"
```

Expected: FAIL — `Cannot find module '../src/queue.js'`

- [ ] **Step 3: Create packages/server/src/queue.ts**

```typescript
import { randomUUID } from 'node:crypto';
import type { Room, Track } from './types.js';

type TrackInput = Omit<Track, 'id'>;

export function addTrack(room: Room, input: TrackInput): Track {
  if (!input.youtubeUrl || !input.title) {
    throw new Error('MISSING_FIELDS');
  }
  const track: Track = { id: randomUUID(), ...input };
  room.queue.push(track);
  return track;
}
```

- [ ] **Step 4: Run tests to verify passing**

```bash
npm test --workspace=packages/server 2>&1 | grep -E "pass|fail|ok|not ok"
```

Expected: all tests pass.

- [ ] **Step 5: Add queue:add handler to ws-handler.ts**

In `packages/server/src/ws-handler.ts`, add the import and handler. After the existing imports, add:

```typescript
import { addTrack } from './queue.js';
```

Add this interface after `RoomLeaveMessage`:

```typescript
interface QueueAddMessage {
  event: 'queue:add';
  youtubeUrl: string;
  title: string;
  artist: string;
  duration: number;
}
```

Add this function before `handleMessage`:

```typescript
function handleQueueAdd(
  rooms: Map<string, Room>,
  wss: WebSocketServer,
  ws: IncomingWs,
  msg: QueueAddMessage
): void {
  if (!ws.userId || !ws.roomId) {
    reply(ws, { event: 'queue:error', code: 'NOT_IN_ROOM' });
    return;
  }
  const room = rooms.get(ws.roomId);
  if (!room) {
    reply(ws, { event: 'queue:error', code: 'ROOM_NOT_FOUND' });
    return;
  }
  try {
    addTrack(room, {
      youtubeUrl: msg.youtubeUrl,
      title: msg.title,
      artist: msg.artist,
      duration: msg.duration,
      queuedBy: ws.userId,
    });
    broadcastToRoom(wss, room, { event: 'queue:update', queue: room.queue });
  } catch (err) {
    reply(ws, { event: 'queue:error', code: (err as Error).message });
  }
}
```

In `handleMessage`, before the final `reply(ws, { event: 'error', code: 'UNKNOWN_EVENT' })`, add:

```typescript
  if (msg['event'] === 'queue:add') {
    if (
      typeof msg['youtubeUrl'] !== 'string' ||
      typeof msg['title'] !== 'string' ||
      typeof msg['artist'] !== 'string' ||
      typeof msg['duration'] !== 'number'
    ) {
      reply(ws, { event: 'queue:error', code: 'MISSING_FIELDS' });
      return;
    }
    handleQueueAdd(rooms, wss, ws, msg as unknown as QueueAddMessage);
    return;
  }
```

- [ ] **Step 6: Verify server tests still pass**

```bash
npm test --workspace=packages/server
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/queue.ts packages/server/src/ws-handler.ts packages/server/__tests__/queue.test.ts
git commit -m "feat(server): queue:add handler + addTrack module"
```

---

### Task 3: Server WS Queue Integration Tests

**Files:**
- Create: `packages/server/__tests__/ws-queue.test.ts`

- [ ] **Step 1: Write WS queue integration tests**

Create `packages/server/__tests__/ws-queue.test.ts`:

```typescript
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer, stopServer, type ServerHandle } from '../src/server.js';
import { registerUser } from '../src/auth.js';

const PORT = 13002;
const JWT_SECRET = 'test-secret-queue';

let server: ServerHandle;

function wsConnect(port: number): WebSocket {
  return new WebSocket(`ws://localhost:${port}`);
}

function nextMsg(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
    ws.once('error', reject);
  });
}

async function authAndJoinRoom(port: number, username: string, password: string, roomName: string, create = false): Promise<WebSocket> {
  const ws = wsConnect(port);
  await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(JSON.stringify({ event: 'auth', action: 'login', username, password }));
  const authMsg = await nextMsg(ws);
  assert.equal(authMsg['event'], 'auth:ok');
  ws.send(JSON.stringify({ event: create ? 'room:create' : 'room:join', name: roomName }));
  const syncMsg = await nextMsg(ws);
  assert.equal(syncMsg['event'], 'state:sync');
  return ws;
}

before(async () => {
  server = await startServer({ port: PORT, jwtSecret: JWT_SECRET, dbPath: ':memory:' });
  registerUser(server.db, 'alice', 'pass123');
  registerUser(server.db, 'bob', 'pass456');
});

after(async () => {
  await stopServer(server);
});

test('queue:add appends track and broadcasts queue:update', async () => {
  const alice = await authAndJoinRoom(PORT, 'alice', 'pass123', 'qtest1', true);

  alice.send(JSON.stringify({
    event: 'queue:add',
    youtubeUrl: 'https://youtube.com/watch?v=abc',
    title: 'Harder Better Faster',
    artist: 'Daft Punk',
    duration: 224,
  }));

  const msg = await nextMsg(alice);
  assert.equal(msg['event'], 'queue:update');
  const queue = msg['queue'] as Array<Record<string, unknown>>;
  assert.equal(queue.length, 1);
  assert.equal(queue[0]!['title'], 'Harder Better Faster');
  assert.equal(queue[0]!['artist'], 'Daft Punk');
  assert.equal(queue[0]!['duration'], 224);

  alice.close();
});

test('queue:add broadcasts to all room members', async () => {
  const alice = await authAndJoinRoom(PORT, 'alice', 'pass123', 'qtest2', true);
  const bob = await authAndJoinRoom(PORT, 'bob', 'pass456', 'qtest2', false);

  // bob joining triggers state:sync to alice — drain it
  await nextMsg(alice);

  alice.send(JSON.stringify({
    event: 'queue:add',
    youtubeUrl: 'https://youtube.com/watch?v=xyz',
    title: 'Get Lucky',
    artist: 'Daft Punk',
    duration: 248,
  }));

  const [aliceMsg, bobMsg] = await Promise.all([nextMsg(alice), nextMsg(bob)]);
  assert.equal(aliceMsg['event'], 'queue:update');
  assert.equal(bobMsg['event'], 'queue:update');
  const aliceQueue = aliceMsg['queue'] as Array<Record<string, unknown>>;
  const bobQueue = bobMsg['queue'] as Array<Record<string, unknown>>;
  assert.equal(aliceQueue[0]!['title'], 'Get Lucky');
  assert.equal(bobQueue[0]!['title'], 'Get Lucky');

  alice.close();
  bob.close();
});

test('queue:add returns queue:error NOT_IN_ROOM if not in room', async () => {
  const ws = wsConnect(PORT);
  await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(JSON.stringify({ event: 'auth', action: 'login', username: 'alice', password: 'pass123' }));
  await nextMsg(ws); // auth:ok

  ws.send(JSON.stringify({
    event: 'queue:add',
    youtubeUrl: 'https://youtube.com/watch?v=abc',
    title: 'A',
    artist: 'X',
    duration: 100,
  }));

  const msg = await nextMsg(ws);
  assert.equal(msg['event'], 'queue:error');
  assert.equal(msg['code'], 'NOT_IN_ROOM');
  ws.close();
});

test('queue:add returns queue:error MISSING_FIELDS for invalid payload', async () => {
  const alice = await authAndJoinRoom(PORT, 'alice', 'pass123', 'qtest3', true);

  alice.send(JSON.stringify({ event: 'queue:add', youtubeUrl: '', title: 'A', artist: 'X', duration: 100 }));
  const msg = await nextMsg(alice);
  assert.equal(msg['event'], 'queue:error');

  alice.close();
});

test('queue accumulates multiple tracks in order', async () => {
  const alice = await authAndJoinRoom(PORT, 'alice', 'pass123', 'qtest4', true);

  const tracks = [
    { youtubeUrl: 'https://youtube.com/watch?v=1', title: 'Track One', artist: 'A', duration: 100 },
    { youtubeUrl: 'https://youtube.com/watch?v=2', title: 'Track Two', artist: 'B', duration: 200 },
    { youtubeUrl: 'https://youtube.com/watch?v=3', title: 'Track Three', artist: 'C', duration: 300 },
  ];

  for (const t of tracks) {
    alice.send(JSON.stringify({ event: 'queue:add', ...t }));
    await nextMsg(alice); // queue:update
  }

  alice.send(JSON.stringify({ event: 'queue:add', youtubeUrl: 'https://youtube.com/watch?v=4', title: 'Track Four', artist: 'D', duration: 400 }));
  const last = await nextMsg(alice);
  const queue = last['queue'] as Array<Record<string, unknown>>;
  assert.equal(queue.length, 4);
  assert.equal(queue[0]!['title'], 'Track One');
  assert.equal(queue[3]!['title'], 'Track Four');

  alice.close();
});
```

- [ ] **Step 2: Run tests**

```bash
npm test --workspace=packages/server
```

Expected: all tests pass including new ws-queue tests.

- [ ] **Step 3: Commit**

```bash
git add packages/server/__tests__/ws-queue.test.ts
git commit -m "test(server): WS integration tests for queue:add"
```

---

### Task 4: youtube-resolver Module (Daemon)

**Files:**
- Create: `packages/daemon/src/youtube-resolver.ts`

- [ ] **Step 1: Write failing test for youtube-resolver**

Create `packages/daemon/__tests__/youtube-resolver.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchYoutube, type SearchResult } from '../src/youtube-resolver.js';

test('searchYoutube returns results with required fields', async () => {
  const results = await searchYoutube('daft punk harder better faster');
  assert.ok(Array.isArray(results), 'returns array');
  assert.ok(results.length > 0, 'returns at least one result');
  const r = results[0]! as SearchResult;
  assert.ok(typeof r.title === 'string' && r.title.length > 0, 'has title');
  assert.ok(typeof r.artist === 'string', 'has artist');
  assert.ok(typeof r.duration === 'number' && r.duration > 0, 'has positive duration');
  assert.ok(typeof r.youtubeUrl === 'string' && r.youtubeUrl.startsWith('http'), 'has url');
});

test('searchYoutube returns at most 5 results', async () => {
  const results = await searchYoutube('piano');
  assert.ok(results.length <= 5);
});

test('searchYoutube throws YT_DLP_NOT_FOUND if yt-dlp missing', async () => {
  const orig = process.env['PATH'];
  process.env['PATH'] = '/nonexistent';
  try {
    await assert.rejects(() => searchYoutube('test'), /YT_DLP_NOT_FOUND/);
  } finally {
    process.env['PATH'] = orig;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test --workspace=packages/daemon 2>&1 | grep -A3 "youtube-resolver"
```

Expected: FAIL — `Cannot find module '../src/youtube-resolver.js'`

- [ ] **Step 3: Create packages/daemon/src/youtube-resolver.ts**

```typescript
import { spawn } from 'node:child_process';

export interface SearchResult {
  title: string;
  artist: string;
  duration: number;
  youtubeUrl: string;
}

export function searchYoutube(query: string, limit = 5): Promise<SearchResult[]> {
  return new Promise((resolve, reject) => {
    const args = [
      `ytsearch${limit}:${query}`,
      '--dump-json',
      '--no-playlist',
      '--quiet',
    ];

    const proc = spawn('yt-dlp', args, { env: process.env });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('YT_DLP_NOT_FOUND'));
      } else {
        reject(err);
      }
    });

    proc.on('close', (code) => {
      if (code !== 0 && !stdout) {
        reject(new Error(`yt-dlp exited with code ${code}: ${stderr.trim()}`));
        return;
      }

      const results: SearchResult[] = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          results.push({
            title: String(entry['title'] ?? 'Unknown'),
            artist: String(entry['uploader'] ?? entry['channel'] ?? 'Unknown'),
            duration: Number(entry['duration'] ?? 0),
            youtubeUrl: String(entry['webpage_url'] ?? ''),
          });
        } catch {
          // skip malformed lines
        }
      }

      resolve(results);
    });
  });
}
```

- [ ] **Step 4: Run tests**

```bash
npm test --workspace=packages/daemon
```

Expected: all tests pass (yt-dlp must be installed; the YT_DLP_NOT_FOUND test manipulates PATH).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/youtube-resolver.ts packages/daemon/__tests__/youtube-resolver.test.ts
git commit -m "feat(daemon): youtube-resolver module using yt-dlp subprocess"
```

---

### Task 5: Daemon IPC Message Handling

**Files:**
- Modify: `packages/daemon/bin/auxd.ts`

The daemon must:
1. Handle IPC `search` messages from TUI → call `searchYoutube` → write `search:results` back to that socket
2. Handle IPC `queue:add` messages from TUI → forward to server via `wsClient.send`

- [ ] **Step 1: Rewrite auxd.ts with IPC message handling**

Replace `packages/daemon/bin/auxd.ts` with:

```typescript
#!/usr/bin/env tsx
import { writeFileSync, rmSync } from 'node:fs';
import type { Socket } from 'node:net';
import { loadCredentials } from '../src/credentials.js';
import { createWsClient, type WsClientHandle } from '../src/ws-client.js';
import { createIpcServer } from '../src/ipc-server.js';
import { searchYoutube } from '../src/youtube-resolver.js';

const PID_FILE = '/tmp/aux.pid';
const SERVER_URL = process.env['AUX_SERVER_URL'] ?? 'ws://localhost:7700';

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
    wsClient.send({
      event: 'queue:add',
      youtubeUrl: msg['youtubeUrl'],
      title: msg['title'],
      artist: msg['artist'],
      duration: msg['duration'],
    });
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

- [ ] **Step 2: Run daemon tests**

```bash
npm test --workspace=packages/daemon
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/bin/auxd.ts
git commit -m "feat(daemon): handle search + queue:add IPC messages from TUI"
```

---

### Task 6: TUI Search + Queue UI

**Files:**
- Modify: `packages/client/src/App.tsx`

The TUI needs:
- Press `s` (when not in search mode) → enter search mode, text input active
- Type query characters, `Backspace` to delete
- Press `Enter` → send `{ event: 'search', query }` to daemon
- Receive `search:results` → show results list
- `↑`/`↓` to navigate results, `Enter` to queue selected track (send `queue:add`)
- Press `Escape` to cancel search
- Receive `queue:update` → update queue panel
- Queue panel shows title, duration (formatted as `m:ss`), queued-by username

- [ ] **Step 1: Write the updated App.tsx**

Replace `packages/client/src/App.tsx` with:

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

interface QueueTrack { id: string; title: string; queuedBy: string; }
interface RoomState { name: string; members: Member[]; queue: QueueTrack[]; }

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
          setRoom(m['room'] as RoomState);
        }
        if (m['event'] === 'queue:update' && Array.isArray(m['queue'])) {
          setRoom((prev) => prev ? { ...prev, queue: m['queue'] as QueueTrack[] } : prev);
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
              {room ? <Text dimColor>Nothing playing yet</Text> : <Text dimColor>Not in a room</Text>}
            </PanelBox>
            <PanelBox title="Queue" focused={focused === 'queue'}>
              {room && room.queue.length > 0
                ? room.queue.map((t) => {
                    const track = t as unknown as Track;
                    return (
                      <Text key={t.id}>
                        {t.title}
                        {track.duration ? ` (${formatDuration(track.duration)})` : ''}
                        {` · ${t.queuedBy}`}
                      </Text>
                    );
                  })
                : <Text dimColor>Queue is empty</Text>}
            </PanelBox>
            <PanelBox title="Members" focused={focused === 'members'}>
              {room && room.members.length > 0
                ? room.members.map((m) => <Text key={m.id}>{m.username}</Text>)
                : <Text dimColor>No members</Text>}
            </PanelBox>
          </Box>
          <Box marginTop={1}><Text dimColor>Tab: switch panel  ·  s: search  ·  q: quit TUI</Text></Box>
        </>
      )}
    </Box>
  );
}
```

- [ ] **Step 2: Run TypeScript build check on client**

```bash
npx tsc --noEmit --project packages/client/tsconfig.json
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/App.tsx
git commit -m "feat(client): TUI search panel + queue display with yt-dlp integration"
```

---

### Task 7: Final Verification

- [ ] **Step 1: Run all tests across all packages**

```bash
npm test --workspace=packages/server && npm test --workspace=packages/daemon
```

Expected: all pass.

- [ ] **Step 2: TypeScript build check all packages**

```bash
npx tsc --noEmit --project packages/server/tsconfig.json && npx tsc --noEmit --project packages/daemon/tsconfig.json && npx tsc --noEmit --project packages/client/tsconfig.json
```

Expected: no errors.

- [ ] **Step 3: Commit and push**

All work should already be committed in earlier tasks. Final push happens via PR in finishing-a-development-branch.
