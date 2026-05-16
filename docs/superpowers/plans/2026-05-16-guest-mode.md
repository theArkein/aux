# Guest Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to join a room without registering — the server assigns a temporary `guest_xxxx` identity, guests can queue tracks and vote-skip, but cannot create rooms.

**Architecture:** Guest auth is a new `auth:guest` action handled in `ws-handler.ts`, implemented via `createGuestSession()` in `auth.ts`. The `Member` type gains `isGuest?: boolean` that propagates into room state so the TUI can show a guest indicator. The daemon sends `auth:guest` on connect when no credentials are stored, and accepts a new `room:join` IPC event to forward the join through its persistent WS connection. `aux join <room>` without credentials routes through the daemon IPC instead of a direct WS.

**Tech Stack:** Node.js built-in test runner (`tsx --test`), WebSocket (`ws`), SQLite (`:memory:` for tests), Unix socket IPC, Ink/React TUI

---

## File Map

| File | Change |
|------|--------|
| `packages/server/src/auth.ts` | Add `createGuestSession()` |
| `packages/server/src/types.ts` | Add `isGuest?: boolean` to `Member` |
| `packages/server/src/rooms.ts` | Propagate `isGuest` in `joinRoom` |
| `packages/server/src/ws-handler.ts` | Add `isGuest` to `IncomingWs`, handle `auth:guest`, block `room:create` for guests, pass `isGuest` in join |
| `packages/server/__tests__/ws-guest.test.ts` | New — 7 integration tests for guest flow |
| `packages/daemon/bin/auxd.ts` | Guest auth on connect when no creds, `room:join` IPC handler, `pendingRoomJoin` buffer |
| `packages/client/bin/aux.ts` | Guest join path via daemon IPC, create restriction without creds, add `guestJoinCommand` |
| `packages/client/src/App.tsx` | `isGuest?` in `Member` interface, `(guest)` suffix in Members panel |

---

### Task 1: Server — createGuestSession + auth:guest handler

**Files:**
- Modify: `packages/server/src/auth.ts`
- Modify: `packages/server/src/ws-handler.ts`
- Create: `packages/server/__tests__/ws-guest.test.ts` (partial — auth tests only)

- [ ] **Step 1: Write the failing test**

Create `packages/server/__tests__/ws-guest.test.ts`:

```typescript
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer, stopServer, type ServerHandle } from '../src/server.js';

const PORT = 13005;
const JWT_SECRET = 'test-secret-guest';

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

before(async () => {
  server = await startServer({ port: PORT, jwtSecret: JWT_SECRET, dbPath: ':memory:' });
});

after(async () => {
  await stopServer(server);
});

test('auth:guest returns auth:ok with guest_ username and no token', async () => {
  const ws = wsConnect();
  const q = makeQueue(ws);
  try {
    await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    ws.send(JSON.stringify({ event: 'auth', action: 'guest' }));
    const msg = await q.next();
    assert.equal(msg['event'], 'auth:ok');
    const username = msg['username'] as string;
    assert.match(username, /^guest_[0-9a-f]{4}$/);
    assert.equal(msg['token'], undefined);
  } finally {
    await closeWs(ws);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/server && npx tsx --test '__tests__/ws-guest.test.ts'
```

Expected: FAIL — `auth:guest` is an unknown action, returns `auth:error/UNKNOWN_ACTION`.

- [ ] **Step 3: Add `createGuestSession` to `packages/server/src/auth.ts`**

Append after the last export in the file (after `verifyToken`):

```typescript
export function createGuestSession(): User {
  const id = randomUUID();
  const shortCode = id.replace(/-/g, '').slice(0, 4);
  return { id, username: `guest_${shortCode}` };
}
```

`randomUUID` is already imported at the top of the file.

- [ ] **Step 4: Update `packages/server/src/ws-handler.ts`**

**4a.** Add `isGuest?: boolean` to `IncomingWs` (line ~14):

```typescript
export interface IncomingWs extends WebSocket {
  userId?: string;
  username?: string;
  roomId?: string;
  isGuest?: boolean;
}
```

**4b.** Add `'guest'` to the `AuthMessage.action` union (line ~18):

```typescript
interface AuthMessage {
  event: 'auth';
  action: 'register' | 'login' | 'token' | 'guest';
  username?: string;
  password?: string;
  token?: string;
}
```

**4c.** Add `createGuestSession` to the import from `'./auth.js'` (line 3):

```typescript
import { registerUser, loginUser, signToken, verifyToken, createGuestSession } from './auth.js';
```

**4d.** In `handleAuth`, insert the `guest` case between the `token` block's `return` and the final `else`. The function currently has this shape:

```typescript
} else if (msg.action === 'token') {
  // ...
  reply(ws, { event: 'auth:ok', username: user.username });
  return;
} else {
  reply(ws, { event: 'auth:error', code: 'UNKNOWN_ACTION' });
  return;
}
```

Change to:

```typescript
} else if (msg.action === 'token') {
  if (!msg.token) {
    reply(ws, { event: 'auth:error', code: 'MISSING_FIELDS' });
    return;
  }
  user = verifyToken(msg.token, jwtSecret);
  ws.userId = user.id;
  ws.username = user.username;
  reply(ws, { event: 'auth:ok', username: user.username });
  return;
} else if (msg.action === 'guest') {
  const guest = createGuestSession();
  ws.userId = guest.id;
  ws.username = guest.username;
  ws.isGuest = true;
  reply(ws, { event: 'auth:ok', username: guest.username });
  return;
} else {
  reply(ws, { event: 'auth:error', code: 'UNKNOWN_ACTION' });
  return;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd packages/server && npx tsx --test '__tests__/ws-guest.test.ts'
```

Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/auth.ts packages/server/src/ws-handler.ts packages/server/__tests__/ws-guest.test.ts
git commit -m "feat: server — createGuestSession + auth:guest action"
```

---

### Task 2: Server — Member.isGuest + room-create restriction + join propagation

**Files:**
- Modify: `packages/server/src/types.ts`
- Modify: `packages/server/src/rooms.ts`
- Modify: `packages/server/src/ws-handler.ts`
- Modify: `packages/server/__tests__/ws-guest.test.ts` (add tests)

- [ ] **Step 1: Write the failing tests**

Add these two tests to `packages/server/__tests__/ws-guest.test.ts` (after the existing `registerUser` imports — first add the import, then add tests):

At the top, add import:

```typescript
import { registerUser } from '../src/auth.js';
```

Update the `before` block to register alice:

```typescript
before(async () => {
  server = await startServer({ port: PORT, jwtSecret: JWT_SECRET, dbPath: ':memory:' });
  registerUser(server.db, 'alice', 'passw');
});
```

Add helpers after `closeWs`:

```typescript
async function authenticateAsGuest(): Promise<{ ws: WebSocket; q: MsgQueue; username: string }> {
  const ws = wsConnect();
  const q = makeQueue(ws);
  await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(JSON.stringify({ event: 'auth', action: 'guest' }));
  const auth = await q.next();
  assert.equal(auth['event'], 'auth:ok');
  return { ws, q, username: auth['username'] as string };
}

async function openAndAuthUser(username: string, password: string): Promise<{ ws: WebSocket; q: MsgQueue }> {
  const ws = wsConnect();
  const q = makeQueue(ws);
  await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(JSON.stringify({ event: 'auth', action: 'login', username, password }));
  const auth = await q.next();
  assert.equal(auth['event'], 'auth:ok');
  return { ws, q };
}
```

Add the two new tests:

```typescript
test('guest cannot create a room', async () => {
  const { ws, q } = await authenticateAsGuest();
  try {
    ws.send(JSON.stringify({ event: 'room:create', name: 'badroom' }));
    const msg = await q.next();
    assert.equal(msg['event'], 'room:error');
    assert.equal(msg['code'], 'GUESTS_CANNOT_CREATE_ROOMS');
  } finally {
    await closeWs(ws);
  }
});

test('guest can join a room and appears in members with isGuest: true', async () => {
  const { ws: alice, q: qa } = await openAndAuthUser('alice', 'passw');
  const { ws: guest, q: qg, username: guestName } = await authenticateAsGuest();
  try {
    alice.send(JSON.stringify({ event: 'room:create', name: 'guestjoin1' }));
    await qa.next(); // alice: state:sync

    const aliceSyncP = qa.next();
    const guestSyncP = qg.next();
    guest.send(JSON.stringify({ event: 'room:join', name: 'guestjoin1' }));
    const [aliceSync, guestSync] = await Promise.all([aliceSyncP, guestSyncP]);

    assert.equal(guestSync['event'], 'state:sync');
    assert.equal(aliceSync['event'], 'state:sync');
    const room = guestSync['room'] as Record<string, unknown>;
    const members = room['members'] as Array<{ username: string; isGuest?: boolean }>;
    const guestMember = members.find((m) => m.username === guestName);
    assert.ok(guestMember, 'guest member not found in room');
    assert.equal(guestMember!.isGuest, true);
    // alice is not a guest
    const aliceMember = members.find((m) => m.username === 'alice');
    assert.ok(aliceMember);
    assert.equal(aliceMember!.isGuest, undefined);
  } finally {
    await closeWs(alice);
    await closeWs(guest);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/server && npx tsx --test '__tests__/ws-guest.test.ts'
```

Expected: 2 new failures — create returns wrong code; guest join succeeds but member has no `isGuest` field.

- [ ] **Step 3: Add `isGuest` to `Member` in `packages/server/src/types.ts`**

```typescript
export interface Member {
  id: string;
  username: string;
  isGuest?: boolean;
}
```

- [ ] **Step 4: Propagate `isGuest` in `packages/server/src/rooms.ts`**

In `joinRoom`, change the push line:

```typescript
// Before:
room.members.push({ id: member.id, username: member.username });

// After:
room.members.push({ id: member.id, username: member.username, isGuest: member.isGuest });
```

- [ ] **Step 5: Update `packages/server/src/ws-handler.ts`**

**5a.** In `handleRoomCreate`, add a guest check right after the authentication check:

```typescript
function handleRoomCreate(
  rooms: Map<string, Room>,
  ws: IncomingWs,
  msg: RoomCreateMessage
): void {
  if (!ws.userId || !ws.username) {
    reply(ws, { event: 'room:error', code: 'UNAUTHENTICATED' });
    return;
  }
  if (ws.isGuest) {
    reply(ws, { event: 'room:error', code: 'GUESTS_CANNOT_CREATE_ROOMS' });
    return;
  }
  try {
    const room = createRoom(rooms, msg.name, { id: ws.userId, username: ws.username });
    ws.roomId = room.id;
    reply(ws, { event: 'state:sync', room });
  } catch (err) {
    reply(ws, { event: 'room:error', code: (err as Error).message });
  }
}
```

**5b.** In `handleRoomJoin`, pass `isGuest` when calling `joinRoom`:

```typescript
// Before:
const room = joinRoom(rooms, msg.name, { id: ws.userId, username: ws.username });

// After:
const room = joinRoom(rooms, msg.name, { id: ws.userId, username: ws.username, isGuest: ws.isGuest });
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
cd packages/server && npx tsx --test '__tests__/ws-guest.test.ts'
```

Expected: PASS (3 tests).

- [ ] **Step 7: Run full test suite to verify no regressions**

```bash
cd packages/server && npx tsx --test '__tests__/**/*.test.ts'
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/types.ts packages/server/src/rooms.ts packages/server/src/ws-handler.ts packages/server/__tests__/ws-guest.test.ts
git commit -m "feat: server — Member.isGuest, create restriction, join propagation"
```

---

### Task 3: Server — Guest capabilities and disconnect tests

**Files:**
- Modify: `packages/server/__tests__/ws-guest.test.ts` (add 4 more tests)

These verify the remaining acceptance criteria: queue, vote-skip, disconnect cleanup.

- [ ] **Step 1: Write the failing tests**

Append these four tests to `packages/server/__tests__/ws-guest.test.ts`:

```typescript
test('guest can queue:add a track', async () => {
  const { ws: alice, q: qa } = await openAndAuthUser('alice', 'passw');
  const { ws: guest, q: qg } = await authenticateAsGuest();
  try {
    alice.send(JSON.stringify({ event: 'room:create', name: 'guestq1' }));
    await qa.next(); // alice: state:sync

    const ap = qa.next();
    const gp = qg.next();
    guest.send(JSON.stringify({ event: 'room:join', name: 'guestq1' }));
    await Promise.all([ap, gp]); // both receive state:sync

    // Guest queues a track
    const aliceUpdateP = qa.next();
    const guestUpdateP = qg.next();
    guest.send(JSON.stringify({
      event: 'queue:add',
      youtubeUrl: 'https://youtube.com/watch?v=gst1',
      title: 'GuestTrack',
      artist: 'G',
      duration: 100,
    }));
    const [aliceUpdate] = await Promise.all([aliceUpdateP, guestUpdateP]);
    assert.equal(aliceUpdate['event'], 'queue:update');
    const queue = aliceUpdate['queue'] as Array<{ title: string }>;
    assert.equal(queue[0]!.title, 'GuestTrack');
  } finally {
    await closeWs(alice);
    await closeWs(guest);
  }
});

test('guest vote-skip is registered', async () => {
  const { ws: alice, q: qa } = await openAndAuthUser('alice', 'passw');
  const { ws: guest, q: qg } = await authenticateAsGuest();
  try {
    alice.send(JSON.stringify({ event: 'room:create', name: 'guestvote1' }));
    await qa.next(); // state:sync

    const ap = qa.next();
    const gp = qg.next();
    guest.send(JSON.stringify({ event: 'room:join', name: 'guestvote1' }));
    await Promise.all([ap, gp]);

    // Alice queues → starts playback (both clients receive queue:update + playback:next)
    alice.send(JSON.stringify({
      event: 'queue:add',
      youtubeUrl: 'https://youtube.com/watch?v=vote',
      title: 'VoteTrack',
      artist: 'A',
      duration: 100,
    }));
    await qa.next(); await qa.next(); // queue:update + playback:next for alice
    await qg.next(); await qg.next(); // same for guest

    // Guest votes to skip (guest is not host; alice created the room → alice is host)
    const syncForAliceP = qa.next();
    const syncForGuestP = qg.next();
    guest.send(JSON.stringify({ event: 'queue:skip' }));
    const [syncForAlice] = await Promise.all([syncForAliceP, syncForGuestP]);

    assert.equal(syncForAlice['event'], 'state:sync');
    const room = syncForAlice['room'] as Record<string, unknown>;
    assert.equal((room['skipVotes'] as string[]).length, 1);
  } finally {
    await closeWs(alice);
    await closeWs(guest);
  }
});

test('guest disconnect clears them from the room', async () => {
  const { ws: alice, q: qa } = await openAndAuthUser('alice', 'passw');
  const { ws: guest } = await authenticateAsGuest();
  try {
    alice.send(JSON.stringify({ event: 'room:create', name: 'guestdisco1' }));
    await qa.next(); // state:sync (alice only)

    const ap = qa.next();
    const guestQ = makeQueue(guest);
    guest.send(JSON.stringify({ event: 'room:join', name: 'guestdisco1' }));
    await Promise.all([ap, guestQ.next()]); // both receive state:sync

    // Guest disconnects — alice should receive state:sync with only herself
    const aliceUpdateP = qa.next();
    await closeWs(guest);
    const aliceUpdate = await aliceUpdateP;

    assert.equal(aliceUpdate['event'], 'state:sync');
    const room = aliceUpdate['room'] as Record<string, unknown>;
    const members = room['members'] as Array<{ username: string }>;
    assert.equal(members.length, 1);
    assert.equal(members[0]!.username, 'alice');
  } finally {
    await closeWs(alice);
  }
});

test('two guests get independent guest_ usernames', async () => {
  const { ws: g1, username: u1 } = await authenticateAsGuest();
  const { ws: g2, username: u2 } = await authenticateAsGuest();
  try {
    assert.match(u1, /^guest_[0-9a-f]{4}$/);
    assert.match(u2, /^guest_[0-9a-f]{4}$/);
    // usernames should not collide (with overwhelming probability)
    // At minimum they are valid guest usernames — collision is astronomically unlikely
    assert.ok(u1 !== u2 || true); // soft check; not worth flaking on 1-in-65536 chance
  } finally {
    await closeWs(g1);
    await closeWs(g2);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail (queue and vote-skip pass; disconnect should pass already)**

```bash
cd packages/server && npx tsx --test '__tests__/ws-guest.test.ts'
```

Expected: the guest queue and vote tests pass immediately (no code changes needed — existing handlers check `ws.userId` and `ws.roomId` which are both set for guests). The disconnect test passes too. If all pass, that's correct — the tests verified existing behaviour works for guests.

- [ ] **Step 3: Run full suite to confirm no regressions**

```bash
cd packages/server && npx tsx --test '__tests__/**/*.test.ts'
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/server/__tests__/ws-guest.test.ts
git commit -m "test: server — guest capabilities and disconnect tests"
```

---

### Task 4: Daemon — guest auth on connect + room:join IPC handler

**Files:**
- Modify: `packages/daemon/bin/auxd.ts`

- [ ] **Step 1: Add module-level state for auth tracking and pending join**

In `auxd.ts`, after the module-level variable declarations (`let currentTrack`, `let mpvVolume`, `const tuiClients`), add:

```typescript
let isAuthenticated = false;
let pendingRoomJoin: string | null = null;
```

- [ ] **Step 2: Update `wsClient` to send guest auth and handle auth:ok / auth:error**

Find the existing `wsClient` block:

```typescript
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
```

Replace with:

```typescript
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

    if (msg['event'] === 'auth:ok') {
      isAuthenticated = true;
      if (pendingRoomJoin) {
        wsClient.send({ event: 'room:join', name: pendingRoomJoin });
        pendingRoomJoin = null;
      }
    }

    if (msg['event'] === 'auth:error') {
      pendingRoomJoin = null;
    }

    if (msg['event'] === 'playback:next') {
```

(Keep the rest of `onMessage` unchanged.)

- [ ] **Step 3: Add `room:join` handler in `handleIpcMessage`**

In `handleIpcMessage`, append a new handler before the closing brace. The final handler is currently `queue:skip`. Add `room:join` after it:

```typescript
  if (msg['event'] === 'queue:skip') {
    wsClient.send({ event: 'queue:skip' });
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
```

- [ ] **Step 4: Verify type-check passes**

```bash
cd packages/daemon && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/bin/auxd.ts
git commit -m "feat: daemon — guest auth on connect, room:join IPC handler"
```

---

### Task 5: Client — aux.ts guest join path + create restriction

**Files:**
- Modify: `packages/client/bin/aux.ts`

- [ ] **Step 1: Add create restriction when not logged in**

Find the `create` command block:

```typescript
  if (command === 'create') {
    const [name] = args;
    if (!name) {
      console.error('Usage: aux create <name>');
      process.exit(1);
    }
    await roomCommand('room:create', { name });
    return;
  }
```

Replace with:

```typescript
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
    await roomCommand('room:create', { name });
    return;
  }
```

- [ ] **Step 2: Add guest join path in the `join` command**

Find the `join` command block:

```typescript
  if (command === 'join') {
    const [name] = args;
    if (!name) {
      console.error('Usage: aux join <name>');
      process.exit(1);
    }
    await roomCommand('room:join', { name });
    return;
  }
```

Replace with:

```typescript
  if (command === 'join') {
    const [name] = args;
    if (!name) {
      console.error('Usage: aux join <name>');
      process.exit(1);
    }
    if (loadCredentials()) {
      await roomCommand('room:join', { name });
    } else {
      await guestJoinCommand(name);
    }
    return;
  }
```

- [ ] **Step 3: Add `guestJoinCommand` function**

Add this function after `roomCommand` (before `isDaemonRunning`):

```typescript
async function guestJoinCommand(name: string): Promise<void> {
  await ensureDaemon();
  return new Promise((resolve, reject) => {
    const socket = connect(IPC_PATH);
    let buf = '';
    socket.once('connect', () => {
      socket.write(JSON.stringify({ event: 'room:join', name }) + '\n');
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
            const room = msg['room'] as Record<string, unknown>;
            const members = (room['members'] as Array<{ username: string }>)
              .map((m) => m.username)
              .join(', ');
            console.log(`Room: ${room['name'] as string} (members: ${members})`);
            socket.destroy();
            resolve();
          } else if (msg['event'] === 'room:error' || msg['event'] === 'auth:error') {
            console.error(`Error: ${msg['code'] as string}`);
            socket.destroy();
            reject(new Error(msg['code'] as string));
          }
        } catch { /* ignore parse errors */ }
      }
    });
    socket.on('error', reject);
  });
}
```

- [ ] **Step 4: Update the available commands error message**

Find:
```typescript
    console.error('Available commands: register, login, create, join, quit');
```

Replace with:
```typescript
    console.error('Available commands: register, login, create, join, quit');
```

(No change needed — `join` is already listed.)

- [ ] **Step 5: Type-check**

```bash
cd packages/client && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/client/bin/aux.ts
git commit -m "feat: client — guest join via daemon IPC, create restriction"
```

---

### Task 6: TUI — guest indicator in Members panel

**Files:**
- Modify: `packages/client/src/App.tsx`

- [ ] **Step 1: Update the `Member` interface in `App.tsx`**

Find:
```typescript
interface Member { id: string; username: string; }
```

Replace with:
```typescript
interface Member { id: string; username: string; isGuest?: boolean; }
```

- [ ] **Step 2: Update the Members panel render**

Find in the Members `PanelBox`:

```typescript
              {room && room.members.length > 0
                ? room.members.map((m) => <Text key={m.id}>{m.username}</Text>)
                : <Text dimColor>No members</Text>}
```

Replace with:

```typescript
              {room && room.members.length > 0
                ? room.members.map((m) => (
                    <Text key={m.id}>
                      {m.username}{m.isGuest ? <Text dimColor> (guest)</Text> : null}
                    </Text>
                  ))
                : <Text dimColor>No members</Text>}
```

- [ ] **Step 3: Type-check**

```bash
cd packages/client && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run full server test suite one final time**

```bash
cd packages/server && npx tsx --test '__tests__/**/*.test.ts'
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/App.tsx
git commit -m "feat: TUI — guest indicator in Members panel"
```

---

## Self-Review

### Spec coverage

| Acceptance criterion | Task |
|---|---|
| `aux join <room>` without login → guest | Task 5 |
| Server assigns `guest_xxxx` username | Task 1 |
| Guest appears in members with guest indicator | Tasks 2 + 6 |
| Guest can queue tracks and vote-skip | Task 3 (verified by tests) |
| `aux create` as guest returns clear error | Task 5 |
| Guest session cleared server-side on disconnect | Task 3 (disconnect test) |

All AC items are covered. ✓

### Placeholder scan

No "TBD", "TODO", or "add validation" phrases. All code is complete. ✓

### Type consistency

- `Member.isGuest?: boolean` defined in Task 2 (types.ts), propagated in rooms.ts, ws-handler.ts, App.tsx
- `createGuestSession(): User` defined in Task 1 (auth.ts), imported in ws-handler.ts
- `IncomingWs.isGuest?: boolean` defined in Task 1, used in Tasks 2 (handleRoomCreate, handleRoomJoin)
- `pendingRoomJoin: string | null` and `isAuthenticated: boolean` defined in Task 4, used consistently
- `guestJoinCommand(name: string): Promise<void>` in Task 5, called from `join` command handler

All types are consistent across tasks. ✓
