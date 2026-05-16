# Skip + Vote-Skip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the host to instantly skip the current track, and non-hosts to cast skip votes that trigger a skip when a majority (>50%) is reached.

**Architecture:** Add `skipVotes: string[]` to `Room` for vote tracking. A new `skip.ts` module exposes `registerVote()`. The `ws-handler` dispatches `queue:skip` to either an immediate host skip or a vote path. The daemon forwards the IPC `queue:skip` event to the server WS. The TUI adds an `x` key binding and shows vote count in the now-playing panel.

**Tech Stack:** Node.js built-in test runner (`tsx --test`), ws, React/Ink (client TUI), TypeScript (strict-ish, but tests run via tsx without type-check)

---

## File Map

| Action | Path |
|--------|------|
| Modify | `packages/server/src/types.ts` — add `skipVotes: string[]` to `Room` |
| Modify | `packages/server/src/rooms.ts` — init `skipVotes: []` in `createRoom` |
| Create | `packages/server/src/skip.ts` — `registerVote()` fn |
| Create | `packages/server/__tests__/skip.test.ts` — unit tests for skip.ts |
| Modify | `packages/server/src/ws-handler.ts` — add `QueueSkipMessage`, `handleQueueSkip`, dispatch |
| Create | `packages/server/__tests__/ws-skip.test.ts` — WS integration tests |
| Modify | `packages/daemon/bin/auxd.ts` — forward `queue:skip` IPC → WS |
| Modify | `packages/client/src/App.tsx` — `x` key binding, vote count display |

---

## Task 1: Add `skipVotes` to Room type and init in `createRoom`

**Files:**
- Modify: `packages/server/src/types.ts`
- Modify: `packages/server/src/rooms.ts`

- [ ] **Step 1: Add `skipVotes` field to `Room` interface**

In `packages/server/src/types.ts`, change the `Room` interface to add `skipVotes`:

```typescript
export interface Room {
  id: string;
  name: string;
  hostId: string;
  members: Member[];
  queue: Track[];
  nowPlaying: Track | null;
  playbackStartedAt: number | null;
  skipVotes: string[];
  createdAt: number;
}
```

- [ ] **Step 2: Initialize `skipVotes` in `createRoom`**

In `packages/server/src/rooms.ts`, update the `createRoom` fn. Find the object literal inside `createRoom` and add `skipVotes: []`:

```typescript
  const room: Room = {
    id: randomUUID(),
    name,
    hostId: host.id,
    members: [{ id: host.id, username: host.username }],
    queue: [],
    nowPlaying: null,
    playbackStartedAt: null,
    skipVotes: [],
    createdAt: Date.now(),
  };
```

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/types.ts packages/server/src/rooms.ts
git commit -m "feat: add skipVotes field to Room type"
```

---

## Task 2: Create `skip.ts` with `registerVote` + unit tests

**Files:**
- Create: `packages/server/src/skip.ts`
- Create: `packages/server/__tests__/skip.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/server/__tests__/skip.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Room, Track } from '../src/types.js';
import { registerVote } from '../src/skip.js';

function makeTrack(id: string): Track {
  return { id, youtubeUrl: `https://youtube.com/watch?v=${id}`, title: `T${id}`, artist: 'A', duration: 180, queuedBy: 'u1' };
}

function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: 'r1',
    name: 'lounge',
    hostId: 'u1',
    members: [
      { id: 'u1', username: 'alice' },
      { id: 'u2', username: 'bob' },
      { id: 'u3', username: 'carol' },
    ],
    queue: [],
    nowPlaying: makeTrack('x'),
    playbackStartedAt: Date.now(),
    skipVotes: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

test('registerVote: first vote below majority — not triggered', () => {
  const room = makeRoom(); // 3 members, need >1.5 = 2 votes
  const result = registerVote(room, 'u2');
  assert.equal(result.triggered, false);
  assert.equal(result.votes, 1);
  assert.equal(result.total, 3);
  assert.deepEqual(room.skipVotes, ['u2']);
});

test('registerVote: majority vote triggers skip and clears votes', () => {
  const room = makeRoom({ skipVotes: ['u2'] }); // 1 existing vote
  const result = registerVote(room, 'u3'); // 2nd vote → 2/3 > 1.5 → triggered
  assert.equal(result.triggered, true);
  assert.equal(result.votes, 2);
  assert.equal(result.total, 3);
  assert.deepEqual(room.skipVotes, []); // cleared on trigger
});

test('registerVote: same user voting twice is idempotent', () => {
  const room = makeRoom({ skipVotes: ['u2'] });
  const result = registerVote(room, 'u2'); // duplicate vote
  assert.equal(result.votes, 1); // still 1, not 2
  assert.equal(result.triggered, false);
});

test('registerVote: 2 members — single vote (50%) does not trigger', () => {
  const room = makeRoom({
    members: [{ id: 'u1', username: 'alice' }, { id: 'u2', username: 'bob' }],
    skipVotes: [],
  });
  const result = registerVote(room, 'u2'); // 1/2 = 50% = not >50%
  assert.equal(result.triggered, false);
  assert.equal(result.votes, 1);
  assert.equal(result.total, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/server && tsx --test '__tests__/skip.test.ts'
```

Expected: error — `Cannot find module '../src/skip.js'`

- [ ] **Step 3: Implement `skip.ts`**

Create `packages/server/src/skip.ts`:

```typescript
import type { Room } from './types.js';

export interface VoteResult {
  triggered: boolean;
  votes: number;
  total: number;
}

export function registerVote(room: Room, userId: string): VoteResult {
  if (!room.skipVotes.includes(userId)) {
    room.skipVotes.push(userId);
  }
  const votes = room.skipVotes.length;
  const total = room.members.length;
  const triggered = votes > total / 2;
  if (triggered) {
    room.skipVotes = [];
  }
  return { triggered, votes, total };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/server && tsx --test '__tests__/skip.test.ts'
```

Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/skip.ts packages/server/__tests__/skip.test.ts
git commit -m "feat: add registerVote for skip vote logic"
```

---

## Task 3: Wire `queue:skip` into `ws-handler.ts`

**Files:**
- Modify: `packages/server/src/ws-handler.ts`

- [ ] **Step 1: Add `registerVote` import and `QueueSkipMessage` type**

At the top of `packages/server/src/ws-handler.ts`, add the import after the existing imports:

```typescript
import { registerVote } from './skip.js';
```

Also add this interface alongside the other message interfaces (after `QueueAddMessage`):

```typescript
interface QueueSkipMessage {
  event: 'queue:skip';
}
```

- [ ] **Step 2: Add `handleQueueSkip` function**

Add this function after `handlePlaybackEnded`:

```typescript
function handleQueueSkip(
  rooms: Map<string, Room>,
  wss: WebSocketServer,
  ws: IncomingWs
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
  if (!room.nowPlaying) {
    reply(ws, { event: 'queue:error', code: 'NOTHING_PLAYING' });
    return;
  }

  if (ws.userId === room.hostId) {
    room.skipVotes = [];
    const nextTrack = endPlayback(room);
    broadcastToRoom(wss, room, { event: 'state:sync', room });
    if (nextTrack) {
      const startAt = Date.now() + 200;
      broadcastToRoom(wss, room, { event: 'playback:next', track: nextTrack, startAt });
    }
  } else {
    const result = registerVote(room, ws.userId);
    if (result.triggered) {
      const nextTrack = endPlayback(room);
      broadcastToRoom(wss, room, { event: 'state:sync', room });
      if (nextTrack) {
        const startAt = Date.now() + 200;
        broadcastToRoom(wss, room, { event: 'playback:next', track: nextTrack, startAt });
      }
    } else {
      broadcastToRoom(wss, room, { event: 'state:sync', room });
    }
  }
}
```

- [ ] **Step 3: Dispatch `queue:skip` in `handleMessage`**

In `handleMessage`, add the dispatch before the final `reply(ws, { event: 'error', code: 'UNKNOWN_EVENT' })`:

```typescript
  if (msg['event'] === 'queue:skip') {
    handleQueueSkip(rooms, wss, ws);
    return;
  }
```

- [ ] **Step 4: Run existing server tests to verify nothing broke**

```bash
cd packages/server && tsx --test '__tests__/**/*.test.ts'
```

Expected: all existing tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/ws-handler.ts
git commit -m "feat: handle queue:skip in ws-handler (host + vote-skip)"
```

---

## Task 4: WS integration tests for skip

**Files:**
- Create: `packages/server/__tests__/ws-skip.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/server/__tests__/ws-skip.test.ts`:

```typescript
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer, stopServer, type ServerHandle } from '../src/server.js';
import { registerUser } from '../src/auth.js';

const PORT = 13004;
const JWT_SECRET = 'test-secret-skip';

let server: ServerHandle;

interface MsgQueue {
  next(): Promise<Record<string, unknown>>;
}

function wsConnect(): WebSocket {
  return new WebSocket(`ws://localhost:${PORT}`);
}

function makeQueue(ws: WebSocket): MsgQueue {
  const buf: Record<string, unknown>[] = [];
  const waiters: Array<(m: Record<string, unknown>) => void> = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString()) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(m);
    else buf.push(m);
  });
  return {
    next(): Promise<Record<string, unknown>> {
      return new Promise((resolve) => {
        const m = buf.shift();
        if (m) resolve(m);
        else waiters.push(resolve);
      });
    },
  };
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.once('close', resolve);
    ws.close();
  });
}

async function openAndAuth(username: string, password: string): Promise<{ ws: WebSocket; q: MsgQueue }> {
  const ws = wsConnect();
  const q = makeQueue(ws);
  await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(JSON.stringify({ event: 'auth', action: 'login', username, password }));
  const auth = await q.next();
  assert.equal(auth['event'], 'auth:ok');
  return { ws, q };
}

function addTrackAndStart(ws: WebSocket, q: MsgQueue): Promise<Record<string, unknown>> {
  return new Promise(async (resolve) => {
    ws.send(JSON.stringify({ event: 'queue:add', youtubeUrl: 'https://youtube.com/watch?v=abc', title: 'Song', artist: 'Artist', duration: 180 }));
    await q.next(); // queue:update
    const pb = await q.next(); // playback:next
    resolve(pb);
  });
}

before(async () => {
  server = await startServer({ port: PORT, jwtSecret: JWT_SECRET, dbPath: ':memory:' });
  registerUser(server.db, 'alice', 'pass123');
  registerUser(server.db, 'bob', 'pass456');
  registerUser(server.db, 'carol', 'pass789');
});

after(async () => {
  await stopServer(server);
});

test('host skip immediately advances track', async () => {
  const { ws: alice, q: qa } = await openAndAuth('alice', 'pass123');

  alice.send(JSON.stringify({ event: 'room:create', name: 'skiptest1' }));
  await qa.next(); // state:sync

  // Queue two tracks
  await addTrackAndStart(alice, qa);
  alice.send(JSON.stringify({ event: 'queue:add', youtubeUrl: 'https://youtube.com/watch?v=second', title: 'Second', artist: 'A', duration: 120 }));
  await qa.next(); // queue:update for second track

  // Host skips
  alice.send(JSON.stringify({ event: 'queue:skip' }));
  const sync = await qa.next();
  assert.equal(sync['event'], 'state:sync');
  const pbNext = await qa.next();
  assert.equal(pbNext['event'], 'playback:next');
  const track = pbNext['track'] as Record<string, unknown>;
  assert.equal(track['title'], 'Second');

  await closeWs(alice);
});

test('host skip with empty queue clears nowPlaying', async () => {
  const { ws: alice, q: qa } = await openAndAuth('alice', 'pass123');

  alice.send(JSON.stringify({ event: 'room:create', name: 'skiptest2' }));
  await qa.next(); // state:sync

  await addTrackAndStart(alice, qa);

  alice.send(JSON.stringify({ event: 'queue:skip' }));
  const sync = await qa.next();
  assert.equal(sync['event'], 'state:sync');
  const room = sync['room'] as Record<string, unknown>;
  assert.equal(room['nowPlaying'], null);

  // No playback:next expected
  let gotExtra = false;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 200);
    alice.once('message', () => { gotExtra = true; clearTimeout(t); resolve(); });
  });
  assert.equal(gotExtra, false);

  await closeWs(alice);
});

test('non-host vote is registered and shown in state:sync', async () => {
  const { ws: alice, q: qa } = await openAndAuth('alice', 'pass123');
  const { ws: bob, q: qb } = await openAndAuth('bob', 'pass456');

  alice.send(JSON.stringify({ event: 'room:create', name: 'skiptest3' }));
  await qa.next(); // state:sync alice

  bob.send(JSON.stringify({ event: 'room:join', name: 'skiptest3' }));
  await qa.next(); // state:sync broadcast to alice (bob joined)
  await qb.next(); // state:sync to bob

  alice.send(JSON.stringify({ event: 'queue:add', youtubeUrl: 'https://youtube.com/watch?v=x', title: 'T1', artist: 'A', duration: 100 }));
  await qa.next(); // queue:update
  await qa.next(); // playback:next (alice)
  await qb.next(); // queue:update (bob)
  await qb.next(); // playback:next (bob)

  // Bob votes to skip (not host — alice is host)
  bob.send(JSON.stringify({ event: 'queue:skip' }));

  // Both get state:sync with skipVotes updated
  const syncForAlice = await qa.next();
  assert.equal(syncForAlice['event'], 'state:sync');
  const roomA = syncForAlice['room'] as Record<string, unknown>;
  const votes = roomA['skipVotes'] as string[];
  assert.equal(votes.length, 1); // bob's vote

  const syncForBob = await qb.next();
  assert.equal(syncForBob['event'], 'state:sync');
  const roomB = syncForBob['room'] as Record<string, unknown>;
  assert.equal((roomB['skipVotes'] as string[]).length, 1);

  await closeWs(alice);
  await closeWs(bob);
});

test('majority vote (>50%) triggers skip', async () => {
  const { ws: alice, q: qa } = await openAndAuth('alice', 'pass123');
  const { ws: bob, q: qb } = await openAndAuth('bob', 'pass456');
  const { ws: carol, q: qc } = await openAndAuth('carol', 'pass789');

  alice.send(JSON.stringify({ event: 'room:create', name: 'skiptest4' }));
  await qa.next(); // state:sync

  bob.send(JSON.stringify({ event: 'room:join', name: 'skiptest4' }));
  await qa.next(); // state:sync (bob joined)
  await qb.next(); // state:sync

  carol.send(JSON.stringify({ event: 'room:join', name: 'skiptest4' }));
  await qa.next(); // state:sync (carol joined)
  await qb.next(); // state:sync
  await qc.next(); // state:sync

  // Alice queues a track (she is host, but let's test vote skip from non-hosts)
  alice.send(JSON.stringify({ event: 'queue:add', youtubeUrl: 'https://youtube.com/watch?v=first', title: 'First', artist: 'A', duration: 100 }));
  // 3 clients get queue:update and playback:next each
  await qa.next(); await qa.next(); // queue:update + playback:next
  await qb.next(); await qb.next();
  await qc.next(); await qc.next();

  // Queue a second track for after the skip
  alice.send(JSON.stringify({ event: 'queue:add', youtubeUrl: 'https://youtube.com/watch?v=second', title: 'Second', artist: 'A', duration: 100 }));
  await qa.next(); // queue:update
  await qb.next();
  await qc.next();

  // Bob votes (1/3 — not majority)
  bob.send(JSON.stringify({ event: 'queue:skip' }));
  const s1a = await qa.next(); // state:sync
  assert.equal(s1a['event'], 'state:sync');
  assert.equal(((s1a['room'] as Record<string, unknown>)['skipVotes'] as string[]).length, 1);
  await qb.next(); // state:sync for bob
  await qc.next(); // state:sync for carol

  // Carol votes (2/3 — majority >1.5 → triggered)
  carol.send(JSON.stringify({ event: 'queue:skip' }));

  // All three should get state:sync with cleared votes + playback:next with Second
  const s2a = await qa.next();
  assert.equal(s2a['event'], 'state:sync');
  const roomAfter = s2a['room'] as Record<string, unknown>;
  assert.deepEqual(roomAfter['skipVotes'], []); // votes cleared

  const pb = await qa.next();
  assert.equal(pb['event'], 'playback:next');
  assert.equal(((pb['track'] as Record<string, unknown>)['title']), 'Second');

  await closeWs(alice);
  await closeWs(bob);
  await closeWs(carol);
});

test('queue:skip when nothing playing returns error', async () => {
  const { ws: alice, q: qa } = await openAndAuth('alice', 'pass123');

  alice.send(JSON.stringify({ event: 'room:create', name: 'skiptest5' }));
  await qa.next(); // state:sync (nothing playing)

  alice.send(JSON.stringify({ event: 'queue:skip' }));
  const err = await qa.next();
  assert.equal(err['event'], 'queue:error');
  assert.equal(err['code'], 'NOTHING_PLAYING');

  await closeWs(alice);
});
```

- [ ] **Step 2: Run tests to verify they fail for the right reason**

```bash
cd packages/server && tsx --test '__tests__/ws-skip.test.ts'
```

Expected: tests fail because `queue:skip` is not yet wired (Task 3 must be complete before this step makes sense — these tests validate Task 3's work)

- [ ] **Step 3: Run all server tests**

```bash
cd packages/server && tsx --test '__tests__/**/*.test.ts'
```

Expected: all tests PASS including the new ws-skip tests

- [ ] **Step 4: Commit**

```bash
git add packages/server/__tests__/ws-skip.test.ts
git commit -m "test: WS integration tests for queue:skip"
```

---

## Task 5: Daemon forwards `queue:skip` IPC → server WS

**Files:**
- Modify: `packages/daemon/bin/auxd.ts`

- [ ] **Step 1: Add `queue:skip` IPC handler in `handleIpcMessage`**

In `packages/daemon/bin/auxd.ts`, find the `handleIpcMessage` function. After the `volume:down` handler block and before the closing brace, add:

```typescript
  if (msg['event'] === 'queue:skip') {
    wsClient.send({ event: 'queue:skip' });
    return;
  }
```

The full `handleIpcMessage` function should now end with:

```typescript
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
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/daemon/bin/auxd.ts
git commit -m "feat: daemon forwards queue:skip IPC event to server"
```

---

## Task 6: TUI — skip key binding + vote count display

**Files:**
- Modify: `packages/client/src/App.tsx`

- [ ] **Step 1: Add `skipVotes` to `RoomState` interface**

In `packages/client/src/App.tsx`, update `RoomState`:

```typescript
interface RoomState {
  name: string;
  members: Member[];
  queue: Track[];
  nowPlaying: Track | null;
  playbackStartedAt: number | null;
  skipVotes: string[];
}
```

- [ ] **Step 2: Add `x` key binding in normal mode**

In the `useInput` handler, inside the `if (mode === 'normal')` block, after the `if (input === '-')` branch, add:

```typescript
      if (input === 'x') {
        clientRef.current?.send({ event: 'queue:skip' });
        return;
      }
```

- [ ] **Step 3: Show vote count in the now-playing panel**

In the now-playing `PanelBox`, after the progress bar/duration line, add a conditional vote count display. The full now-playing inner content becomes:

```tsx
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
                  {room && room.skipVotes.length > 0 && (
                    <Text color="yellow">
                      {room.skipVotes.length}/{room.members.length} votes to skip
                    </Text>
                  )}
                </Box>
              ) : (
                <Text dimColor>{room ? 'Nothing playing' : 'Not in a room'}</Text>
              )}
```

- [ ] **Step 4: Update keyboard shortcut hint**

Update the hint bar at the bottom to include the skip shortcut. Find the `<Text dimColor>` containing the shortcut hints and update it:

```tsx
            <Text dimColor>Tab: switch panel  ·  s: search  ·  x: skip  ·  +/-: volume  ·  q: quit TUI</Text>
```

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/App.tsx
git commit -m "feat: TUI skip key binding and vote count display"
```

---

## Self-Review

**Spec coverage check:**
- ✅ Host pressing skip → immediate `queue:skip` → Task 3 `handleQueueSkip` host path
- ✅ Non-host pressing skip → registers a vote → Task 3 vote path via `registerVote`
- ✅ Vote count shown in now-playing panel → Task 6 Step 3 renders `skipVotes.length/members.length`
- ✅ Majority vote (>50%) triggers server skip → `registerVote` returns `triggered: true`, Task 3 calls `endPlayback`
- ✅ Next track begins playing → `endPlayback` returns next track, `playback:next` broadcast with `startAt`
- ✅ Votes reset after skip → `registerVote` clears `skipVotes` on trigger; host path sets `room.skipVotes = []` before `endPlayback`

**Placeholder scan:** No TBDs, all code blocks are complete.

**Type consistency:**
- `registerVote(room, userId)` — used consistently in skip.ts and ws-handler.ts
- `room.skipVotes` — initialized in `createRoom`, added to `Room` interface in Task 1, referenced in ws-handler (Task 3) and App.tsx (Task 6)
- `endPlayback(room)` — imported in ws-handler already, used identically to existing `handlePlaybackEnded` pattern
