# Friends + Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a friends system with real-time presence so authenticated users can add friends by username, see which room each friend is in, and join a friend's room directly from the TUI Friends panel.

**Architecture:** Friendships are stored in a new SQLite `friendships` table (directed: Alice adds Bob means Alice's list includes Bob, but not vice-versa). Presence (online/offline + current room) lives in a server-side in-memory `Map<userId, PresenceState>` updated on WS authenticate, disconnect, room create/join/leave. When any user's presence changes, the server queries who has them as a friend and sends each watcher a fresh full `friends:list` payload — no incremental diffs. The daemon forwards `friends:list` events to TUI clients, caches the latest for new connections, and requests `friend:list` from the server after auth. The TUI gains a fourth "Friends" panel with ↑↓ navigation and Enter-to-join.

**Tech Stack:** Node.js `node:test`, `better-sqlite3`, `ws` WebSocket, Ink/React TUI, TypeScript/tsx

---

## File Structure

**New files:**
- `packages/server/src/friends.ts` — `addFriend`, `getFriends` DB operations
- `packages/server/__tests__/friends.test.ts` — unit tests for friends.ts
- `packages/server/__tests__/ws-friends.test.ts` — WS integration tests (PORT 13006)

**Modified files:**
- `packages/server/src/db.ts` — add `friendships` table to SCHEMA constant
- `packages/server/src/types.ts` — add `PresenceState`, `FriendPresence` interfaces
- `packages/server/src/server.ts` — add `presence: Map<string, PresenceState>` to `ServerHandle`; thread `presence` and `db` to `handleMessage` / `handleDisconnect`
- `packages/server/src/ws-handler.ts` — add `presence` param to exported functions; add `buildFriendList` + `broadcastFriendsListToWatchers` helpers; track presence after auth/room events; add `handleFriendAdd` + `handleFriendList`
- `packages/daemon/bin/auxd.ts` — request `friend:list` after auth:ok; cache `latestFriendsList`; send cached list to new IPC connections
- `packages/client/bin/aux.ts` — add `aux friend add <username>` command
- `packages/client/src/App.tsx` — add `FriendPresence` type, `friends`/`selectedFriendIdx` state, `friends:list` handler, Friends panel, navigation + join keybindings

---

### Task 1: Add `friendships` table to DB schema

**Files:**
- Modify: `packages/server/src/db.ts`

- [ ] **Step 1: Update SCHEMA in db.ts**

Open `packages/server/src/db.ts`. Replace the `SCHEMA` constant with:

```typescript
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    username     TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS friendships (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    friend_id  TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, friend_id)
  );
`;
```

- [ ] **Step 2: Verify compiles**

```bash
cd packages/server && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/db.ts
git commit -m "feat(server): add friendships table to schema"
```

---

### Task 2: Create `friends.ts` with `addFriend` and `getFriends`

**Files:**
- Create: `packages/server/src/friends.ts`
- Create: `packages/server/__tests__/friends.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/server/__tests__/friends.test.ts`:

```typescript
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../src/db.js';
import { registerUser } from '../src/auth.js';
import { addFriend, getFriends } from '../src/friends.js';
import type Database from 'better-sqlite3';

let db: Database.Database;

before(() => {
  db = initDb(':memory:');
  registerUser(db, 'alice', 'pass');
  registerUser(db, 'bob', 'pass');
  registerUser(db, 'carol', 'pass');
});

after(() => {
  closeDb(db);
});

test('addFriend returns the friend User', () => {
  const alice = db.prepare('SELECT id FROM users WHERE username = ?').get('alice') as { id: string };
  const friend = addFriend(db, alice.id, 'bob');
  assert.equal(friend.username, 'bob');
  assert.ok(friend.id);
});

test('addFriend throws UNKNOWN_USER for nonexistent username', () => {
  const alice = db.prepare('SELECT id FROM users WHERE username = ?').get('alice') as { id: string };
  assert.throws(() => addFriend(db, alice.id, 'nobody'), { message: 'UNKNOWN_USER' });
});

test('addFriend throws SELF_FRIEND when adding yourself', () => {
  const alice = db.prepare('SELECT id FROM users WHERE username = ?').get('alice') as { id: string };
  assert.throws(() => addFriend(db, alice.id, 'alice'), { message: 'SELF_FRIEND' });
});

test('addFriend throws ALREADY_FRIENDS on duplicate', () => {
  const alice = db.prepare('SELECT id FROM users WHERE username = ?').get('alice') as { id: string };
  addFriend(db, alice.id, 'carol');
  assert.throws(() => addFriend(db, alice.id, 'carol'), { message: 'ALREADY_FRIENDS' });
});

test('getFriends returns friends added by userId', () => {
  const alice = db.prepare('SELECT id FROM users WHERE username = ?').get('alice') as { id: string };
  const friends = getFriends(db, alice.id);
  const names = friends.map((f) => f.username).sort();
  assert.ok(names.includes('bob'));
  assert.ok(names.includes('carol'));
});

test('getFriends returns empty array for user with no friends', () => {
  const bob = db.prepare('SELECT id FROM users WHERE username = ?').get('bob') as { id: string };
  const friends = getFriends(db, bob.id);
  assert.equal(friends.length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/server && npx tsx --test '__tests__/friends.test.ts'
```

Expected: FAIL — cannot find module `../src/friends.js`.

- [ ] **Step 3: Create `packages/server/src/friends.ts`**

```typescript
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { User } from './types.js';

export function addFriend(db: Database.Database, userId: string, friendUsername: string): User {
  const friend = db
    .prepare('SELECT id, username FROM users WHERE username = ?')
    .get(friendUsername) as { id: string; username: string } | undefined;
  if (!friend) throw new Error('UNKNOWN_USER');
  if (friend.id === userId) throw new Error('SELF_FRIEND');

  const existing = db
    .prepare('SELECT id FROM friendships WHERE user_id = ? AND friend_id = ?')
    .get(userId, friend.id) as { id: string } | undefined;
  if (existing) throw new Error('ALREADY_FRIENDS');

  db.prepare(
    'INSERT INTO friendships (id, user_id, friend_id, created_at) VALUES (?, ?, ?, ?)'
  ).run(randomUUID(), userId, friend.id, Date.now());

  return { id: friend.id, username: friend.username };
}

export function getFriends(db: Database.Database, userId: string): User[] {
  return db
    .prepare(
      `SELECT u.id, u.username
       FROM friendships f
       JOIN users u ON u.id = f.friend_id
       WHERE f.user_id = ?`
    )
    .all(userId) as User[];
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/server && npx tsx --test '__tests__/friends.test.ts'
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/friends.ts packages/server/__tests__/friends.test.ts
git commit -m "feat(server): add friends.ts with addFriend and getFriends"
```

---

### Task 3: Add `PresenceState` and `FriendPresence` to types.ts

**Files:**
- Modify: `packages/server/src/types.ts`

- [ ] **Step 1: Append the two new interfaces to `packages/server/src/types.ts`**

Add at the end of the file (after the `Room` interface):

```typescript
export interface PresenceState {
  status: 'online' | 'offline';
  roomId: string | null;
}

export interface FriendPresence {
  id: string;
  username: string;
  status: 'online' | 'offline';
  roomName: string | null;
}
```

- [ ] **Step 2: Verify compiles**

```bash
cd packages/server && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/types.ts
git commit -m "feat(server): add PresenceState and FriendPresence types"
```

---

### Task 4: Add `presence` Map to `ServerHandle` and thread it through `server.ts`

**Files:**
- Modify: `packages/server/src/server.ts`

- [ ] **Step 1: Replace the entire contents of `packages/server/src/server.ts`**

```typescript
import 'dotenv/config';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { initDb, closeDb } from './db.js';
import { handleMessage, handleDisconnect, type IncomingWs } from './ws-handler.js';
import type { Room, PresenceState } from './types.js';
import type Database from 'better-sqlite3';
import type { Server } from 'node:http';

export interface ServerOptions {
  port?: number;
  jwtSecret?: string;
  dbPath?: string;
}

export interface ServerHandle {
  httpServer: Server;
  wss: WebSocketServer;
  db: Database.Database;
  rooms: Map<string, Room>;
  presence: Map<string, PresenceState>;
}

export async function startServer(opts: ServerOptions = {}): Promise<ServerHandle> {
  const port = opts.port ?? Number(process.env['PORT'] ?? 3000);
  const jwtSecret = opts.jwtSecret ?? process.env['JWT_SECRET'];
  const dbPath = opts.dbPath ?? process.env['DATABASE_PATH'] ?? './aux.db';

  if (!jwtSecret) throw new Error('JWT_SECRET is required');

  const db = initDb(dbPath);
  const rooms = new Map<string, Room>();
  const presence = new Map<string, PresenceState>();
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    const typedWs = ws as IncomingWs;
    typedWs.on('message', (raw) =>
      handleMessage(db, jwtSecret, typedWs, raw.toString(), rooms, wss, presence)
    );
    typedWs.on('error', (err) => console.error('ws error:', err.message));
    typedWs.on('close', () => handleDisconnect(db, rooms, wss, typedWs, presence));
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  console.log(`aux-server listening on :${port}`);

  return { httpServer, wss, db, rooms, presence };
}

export async function stopServer({ httpServer, wss, db }: ServerHandle): Promise<void> {
  wss.close();
  closeDb(db);
  await new Promise<void>((resolve, reject) =>
    httpServer.close((err) => (err ? reject(err) : resolve()))
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  startServer().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Verify — expect a compile error from ws-handler.ts**

```bash
cd packages/server && npx tsc --noEmit
```

Expected: compile error because `handleMessage` and `handleDisconnect` signatures don't match yet. This is expected and will be fixed in Task 5.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/server.ts
git commit -m "feat(server): add presence Map to ServerHandle, update handler call sites"
```

---

### Task 5: Update `ws-handler.ts` — presence tracking, helpers, friend handlers

**Files:**
- Modify: `packages/server/src/ws-handler.ts`

This is the largest task. It adds the `presence` parameter to exported functions, adds two helper functions, tracks presence after each state-changing event, and adds the `friend:add` / `friend:list` handlers.

- [ ] **Step 1: Update imports at the top of ws-handler.ts**

Replace the existing import block with:

```typescript
import type Database from 'better-sqlite3';
import { WebSocket, type WebSocketServer } from 'ws';
import { registerUser, loginUser, signToken, verifyToken, createGuestSession } from './auth.js';
import { createRoom, joinRoom, leaveRoom } from './rooms.js';
import { addTrack } from './queue.js';
import { registerVote } from './skip.js';
import { startPlayback, endPlayback } from './playback.js';
import { addFriend, getFriends } from './friends.js';
import type { User, Room, PresenceState, FriendPresence } from './types.js';
```

- [ ] **Step 2: Add `buildFriendList` and `broadcastFriendsListToWatchers` after the existing `broadcastToRoom` function**

```typescript
function buildFriendList(
  db: Database.Database,
  userId: string,
  presence: Map<string, PresenceState>,
  rooms: Map<string, Room>
): FriendPresence[] {
  const friends = getFriends(db, userId);
  return friends.map((f) => {
    const p = presence.get(f.id);
    const status = p?.status ?? 'offline';
    const roomId = p?.roomId ?? null;
    const room = roomId ? rooms.get(roomId) : null;
    return { id: f.id, username: f.username, status, roomName: room?.name ?? null };
  });
}

function broadcastFriendsListToWatchers(
  db: Database.Database,
  wss: WebSocketServer,
  userId: string,
  presence: Map<string, PresenceState>,
  rooms: Map<string, Room>
): void {
  const watchers = db
    .prepare('SELECT user_id FROM friendships WHERE friend_id = ?')
    .all(userId) as { user_id: string }[];
  const watcherIds = new Set(watchers.map((w) => w.user_id));
  for (const client of wss.clients) {
    const c = client as IncomingWs;
    if (c.userId && watcherIds.has(c.userId) && c.readyState === WebSocket.OPEN) {
      reply(c, {
        event: 'friends:list',
        friends: buildFriendList(db, c.userId, presence, rooms),
      });
    }
  }
}
```

- [ ] **Step 3: Add `handleFriendAdd` and `handleFriendList` functions before `handleDisconnect`**

```typescript
function handleFriendAdd(
  db: Database.Database,
  ws: IncomingWs,
  username: string,
  presence: Map<string, PresenceState>,
  rooms: Map<string, Room>
): void {
  if (!ws.userId || ws.isGuest) {
    reply(ws, { event: 'friend:error', code: 'NOT_AUTHENTICATED' });
    return;
  }
  try {
    addFriend(db, ws.userId, username);
    reply(ws, { event: 'friends:list', friends: buildFriendList(db, ws.userId, presence, rooms) });
  } catch (err) {
    reply(ws, { event: 'friend:error', code: (err as Error).message });
  }
}

function handleFriendList(
  db: Database.Database,
  ws: IncomingWs,
  presence: Map<string, PresenceState>,
  rooms: Map<string, Room>
): void {
  if (!ws.userId || ws.isGuest) {
    reply(ws, { event: 'friend:error', code: 'NOT_AUTHENTICATED' });
    return;
  }
  reply(ws, { event: 'friends:list', friends: buildFriendList(db, ws.userId, presence, rooms) });
}
```

- [ ] **Step 4: Replace `handleDisconnect` with the updated signature**

Replace the existing exported `handleDisconnect` with:

```typescript
export function handleDisconnect(
  db: Database.Database,
  rooms: Map<string, Room>,
  wss: WebSocketServer,
  ws: IncomingWs,
  presence: Map<string, PresenceState>
): void {
  if (ws.roomId && ws.userId) {
    const updated = leaveRoom(rooms, ws.roomId, ws.userId);
    ws.roomId = undefined;
    if (updated) {
      broadcastToRoom(wss, updated, { event: 'state:sync', room: updated });
    }
  }
  if (ws.userId) {
    presence.set(ws.userId, { status: 'offline', roomId: null });
    broadcastFriendsListToWatchers(db, wss, ws.userId, presence, rooms);
  }
}
```

- [ ] **Step 5: Replace `handleMessage` with the updated signature and presence tracking**

Replace the entire exported `handleMessage` function with:

```typescript
export function handleMessage(
  db: Database.Database,
  jwtSecret: string,
  ws: IncomingWs,
  raw: string,
  rooms: Map<string, Room>,
  wss: WebSocketServer,
  presence: Map<string, PresenceState>
): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    reply(ws, { event: 'error', code: 'BAD_JSON' });
    return;
  }

  if (msg['event'] === 'auth') {
    const prevUserId = ws.userId;
    handleAuth(db, jwtSecret, ws, msg as unknown as AuthMessage);
    if (ws.userId && ws.userId !== prevUserId) {
      presence.set(ws.userId, { status: 'online', roomId: null });
      broadcastFriendsListToWatchers(db, wss, ws.userId, presence, rooms);
    }
    return;
  }

  if (msg['event'] === 'room:create') {
    if (typeof msg['name'] !== 'string') {
      reply(ws, { event: 'room:error', code: 'MISSING_FIELDS' });
      return;
    }
    handleRoomCreate(rooms, ws, msg as unknown as RoomCreateMessage);
    if (ws.userId && ws.roomId) {
      presence.set(ws.userId, { status: 'online', roomId: ws.roomId });
      broadcastFriendsListToWatchers(db, wss, ws.userId, presence, rooms);
    }
    return;
  }

  if (msg['event'] === 'room:join') {
    if (typeof msg['name'] !== 'string') {
      reply(ws, { event: 'room:error', code: 'MISSING_FIELDS' });
      return;
    }
    handleRoomJoin(rooms, wss, ws, msg as unknown as RoomJoinMessage);
    if (ws.userId && ws.roomId) {
      presence.set(ws.userId, { status: 'online', roomId: ws.roomId });
      broadcastFriendsListToWatchers(db, wss, ws.userId, presence, rooms);
    }
    return;
  }

  if (msg['event'] === 'room:leave') {
    const prevRoomId = ws.roomId;
    handleRoomLeave(rooms, wss, ws);
    if (ws.userId && prevRoomId && !ws.roomId) {
      presence.set(ws.userId, { status: 'online', roomId: null });
      broadcastFriendsListToWatchers(db, wss, ws.userId, presence, rooms);
    }
    return;
  }

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

  if (msg['event'] === 'playback:ended') {
    handlePlaybackEnded(rooms, wss, ws);
    return;
  }

  if (msg['event'] === 'queue:skip') {
    handleQueueSkip(rooms, wss, ws);
    return;
  }

  if (msg['event'] === 'friend:add') {
    if (typeof msg['username'] !== 'string' || !msg['username']) {
      reply(ws, { event: 'friend:error', code: 'MISSING_FIELDS' });
      return;
    }
    handleFriendAdd(db, ws, msg['username'] as string, presence, rooms);
    return;
  }

  if (msg['event'] === 'friend:list') {
    handleFriendList(db, ws, presence, rooms);
    return;
  }

  reply(ws, { event: 'error', code: 'UNKNOWN_EVENT' });
}
```

- [ ] **Step 6: Verify the full server package compiles**

```bash
cd packages/server && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/ws-handler.ts
git commit -m "feat(server): presence tracking, buildFriendList, friend:add/list handlers"
```

---

### Task 6: WS integration tests for friends and presence

**Files:**
- Create: `packages/server/__tests__/ws-friends.test.ts`

- [ ] **Step 1: Create the test file**

Create `packages/server/__tests__/ws-friends.test.ts`:

```typescript
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer, stopServer } from '../src/server.js';
import { registerUser } from '../src/auth.js';
import type { ServerHandle } from '../src/server.js';

const PORT = 13006;
const JWT_SECRET = 'test-secret-friends';
const URL = `ws://localhost:${PORT}`;

let server: ServerHandle;

before(async () => {
  server = await startServer({ port: PORT, jwtSecret: JWT_SECRET, dbPath: ':memory:' });
  registerUser(server.db, 'alice', 'pass');
  registerUser(server.db, 'bob', 'pass');
  registerUser(server.db, 'carol', 'pass');
});

after(async () => {
  await stopServer(server);
});

function openWs(): WebSocket {
  return new WebSocket(URL);
}

function send(ws: WebSocket, msg: object): void {
  ws.send(JSON.stringify(msg));
}

function waitMsg(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString())));
    ws.once('error', reject);
  });
}

async function authenticate(ws: WebSocket, username: string, password: string): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) {
    await new Promise<void>((resolve) => ws.once('open', resolve));
  }
  send(ws, { event: 'auth', action: 'login', username, password });
  const msg = await waitMsg(ws);
  assert.equal(msg['event'], 'auth:ok');
}

test('friend:add returns friends:list containing the added friend as offline', async () => {
  const ws = openWs();
  try {
    await authenticate(ws, 'alice', 'pass');
    send(ws, { event: 'friend:add', username: 'bob' });
    const msg = await waitMsg(ws);
    assert.equal(msg['event'], 'friends:list');
    const friends = msg['friends'] as Array<{ username: string; status: string; roomName: string | null }>;
    assert.equal(friends.length, 1);
    assert.equal(friends[0]!.username, 'bob');
    assert.equal(friends[0]!.status, 'offline');
    assert.equal(friends[0]!.roomName, null);
  } finally {
    ws.close();
    await new Promise((r) => ws.once('close', r));
  }
});

test('friend:add returns UNKNOWN_USER for nonexistent username', async () => {
  const ws = openWs();
  try {
    await authenticate(ws, 'alice', 'pass');
    send(ws, { event: 'friend:add', username: 'nobody' });
    const msg = await waitMsg(ws);
    assert.equal(msg['event'], 'friend:error');
    assert.equal(msg['code'], 'UNKNOWN_USER');
  } finally {
    ws.close();
    await new Promise((r) => ws.once('close', r));
  }
});

test('friend:add returns NOT_AUTHENTICATED when unauthenticated', async () => {
  const ws = openWs();
  try {
    await new Promise<void>((resolve) => ws.once('open', resolve));
    send(ws, { event: 'friend:add', username: 'bob' });
    const msg = await waitMsg(ws);
    assert.equal(msg['event'], 'friend:error');
    assert.equal(msg['code'], 'NOT_AUTHENTICATED');
  } finally {
    ws.close();
    await new Promise((r) => ws.once('close', r));
  }
});

test('friend:list returns empty list for user with no friends', async () => {
  const ws = openWs();
  try {
    await authenticate(ws, 'carol', 'pass');
    send(ws, { event: 'friend:list' });
    const msg = await waitMsg(ws);
    assert.equal(msg['event'], 'friends:list');
    assert.deepEqual(msg['friends'], []);
  } finally {
    ws.close();
    await new Promise((r) => ws.once('close', r));
  }
});

test('friends:list updates in real-time when a friend connects and joins a room', async () => {
  const aliceWs = openWs();
  const carolWs = openWs();
  try {
    await authenticate(aliceWs, 'alice', 'pass');
    send(aliceWs, { event: 'friend:add', username: 'carol' });
    await waitMsg(aliceWs); // consume friends:list (carol offline)

    // carol connects → alice gets updated friends:list with carol online
    await authenticate(carolWs, 'carol', 'pass');
    const onlineUpdate = await waitMsg(aliceWs);
    assert.equal(onlineUpdate['event'], 'friends:list');
    const onlineFriends = onlineUpdate['friends'] as Array<{
      username: string; status: string; roomName: string | null;
    }>;
    const carolOnline = onlineFriends.find((f) => f.username === 'carol');
    assert.ok(carolOnline, 'carol should appear in alice friends list');
    assert.equal(carolOnline!.status, 'online');
    assert.equal(carolOnline!.roomName, null);

    // carol creates a room → alice gets updated friends:list with carol's room name
    send(carolWs, { event: 'room:create', name: 'presenceroom' });
    await waitMsg(carolWs); // consume carol's state:sync
    const roomUpdate = await waitMsg(aliceWs);
    assert.equal(roomUpdate['event'], 'friends:list');
    const roomFriends = roomUpdate['friends'] as Array<{
      username: string; status: string; roomName: string | null;
    }>;
    const carolInRoom = roomFriends.find((f) => f.username === 'carol');
    assert.ok(carolInRoom);
    assert.equal(carolInRoom!.status, 'online');
    assert.equal(carolInRoom!.roomName, 'presenceroom');
  } finally {
    aliceWs.close();
    carolWs.close();
    await Promise.all([
      new Promise((r) => aliceWs.once('close', r)),
      new Promise((r) => carolWs.once('close', r)),
    ]);
  }
});
```

- [ ] **Step 2: Run the new tests**

```bash
cd packages/server && npx tsx --test '__tests__/ws-friends.test.ts'
```

Expected: 5 tests pass.

- [ ] **Step 3: Run the full test suite to check for regressions**

```bash
cd packages/server && npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/server/__tests__/ws-friends.test.ts
git commit -m "test(server): WS integration tests for friends and presence"
```

---

### Task 7: Daemon — forward `friends:list`, cache for new IPC connections, request on auth

**Files:**
- Modify: `packages/daemon/bin/auxd.ts`

Three changes: (1) add `latestFriendsList` variable, (2) request `friend:list` after auth:ok and cache incoming `friends:list`, (3) send the cached list to new IPC connections.

- [ ] **Step 1: Add `latestFriendsList` variable**

After the line `let pendingRoomJoin: string | null = null;`, add:

```typescript
let latestFriendsList: object | null = null;
```

- [ ] **Step 2: Update `onMessage` to request `friend:list` and cache `friends:list`**

In the `onMessage(msg)` callback, update the `auth:ok` block and add a new `friends:list` block. The updated section (showing only the changed/added logic, keeping the rest untouched):

```typescript
  onMessage(msg) {
    broadcast(msg);

    if (msg['event'] === 'auth:ok') {
      isAuthenticated = true;
      wsClient.send({ event: 'friend:list' });
      if (pendingRoomJoin) {
        wsClient.send({ event: 'room:join', name: pendingRoomJoin });
        pendingRoomJoin = null;
      }
    }

    if (msg['event'] === 'auth:error') {
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
```

- [ ] **Step 3: Send cached `friends:list` to new IPC connections**

In `createIpcServer`'s `onConnection` callback, after `tuiClients.add(socket);`, add:

```typescript
    if (latestFriendsList) {
      socket.write(JSON.stringify(latestFriendsList) + '\n');
    }
```

The updated `onConnection`:

```typescript
  onConnection(socket) {
    tuiClients.add(socket);
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
```

- [ ] **Step 4: Verify compiles**

```bash
cd packages/daemon && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/bin/auxd.ts
git commit -m "feat(daemon): request friend:list on auth, forward and cache friends:list"
```

---

### Task 8: Client CLI — `aux friend add <username>`

**Files:**
- Modify: `packages/client/bin/aux.ts`

- [ ] **Step 1: Add the `friend` command handler in `main()`**

In `packages/client/bin/aux.ts`, inside `main()`, add the `friend` handler before the `Unknown command` block:

```typescript
  if (command === 'friend') {
    const [subcommand, username] = args;
    if (subcommand !== 'add' || !username) {
      console.error('Usage: aux friend add <username>');
      process.exit(1);
    }
    await friendAddCommand(username);
    return;
  }
```

Also update the error message in the `Unknown command` block:

```typescript
  console.error(`Unknown command: ${command}`);
  console.error('Available commands: register, login, create, join, quit, friend');
  process.exit(1);
```

- [ ] **Step 2: Add `friendAddCommand` function after `guestJoinCommand`**

```typescript
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
        const friends = msg['friends'] as Array<{
          username: string;
          status: string;
          roomName: string | null;
        }>;
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
```

- [ ] **Step 3: Verify compiles**

```bash
cd packages/client && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/client/bin/aux.ts
git commit -m "feat(client): add 'aux friend add <username>' CLI command"
```

---

### Task 9: TUI — Friends panel with presence indicators and Enter-to-join

**Files:**
- Modify: `packages/client/src/App.tsx`

- [ ] **Step 1: Add `FriendPresence` interface, update `PanelId` / `PANELS`, add state**

In `packages/client/src/App.tsx`:

1. Add `FriendPresence` interface after the `SearchResult` interface:

```typescript
interface FriendPresence {
  id: string;
  username: string;
  status: 'online' | 'offline';
  roomName: string | null;
}
```

2. Replace `PanelId` and `PANELS` at the top of the file:

```typescript
type PanelId = 'nowPlaying' | 'queue' | 'members' | 'friends';
const PANELS: PanelId[] = ['nowPlaying', 'queue', 'members', 'friends'];
```

3. Inside the `App` component, add two state variables after the `selectedIdx` line:

```typescript
const [friends, setFriends] = useState<FriendPresence[]>([]);
const [selectedFriendIdx, setSelectedFriendIdx] = useState(0);
```

- [ ] **Step 2: Handle `friends:list` in the IPC `onMessage` callback**

In the `useEffect`, inside the `onMessage` handler, add after the `search:error` block:

```typescript
        if (m['event'] === 'friends:list' && Array.isArray(m['friends'])) {
          setFriends(m['friends'] as FriendPresence[]);
        }
```

- [ ] **Step 3: Add Friends navigation keybindings**

In `useInput`, inside the `if (mode === 'normal')` block, add after the `if (input === 'x')` block:

```typescript
      if (focused === 'friends') {
        if (key.upArrow) {
          setSelectedFriendIdx((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedFriendIdx((i) => Math.min(friends.length - 1, i + 1));
          return;
        }
        if (key.return) {
          const friend = friends[selectedFriendIdx];
          if (friend?.roomName) {
            clientRef.current?.send({ event: 'room:join', name: friend.roomName });
          }
          return;
        }
      }
```

- [ ] **Step 4: Add the Friends panel to the render output**

In the JSX, inside the `<Box gap={1}>` that contains the three existing panels, add after the `Members` panel:

```tsx
<PanelBox title="Friends" focused={focused === 'friends'}>
  {friends.length > 0
    ? friends.map((f, i) => (
        <Box key={f.id}>
          <Text color={focused === 'friends' && i === selectedFriendIdx ? 'cyan' : undefined}>
            {focused === 'friends' && i === selectedFriendIdx ? '▶ ' : '  '}
            {f.username}
            {f.status === 'online'
              ? <Text color="green">{f.roomName ? ` ● ${f.roomName}` : ' ●'}</Text>
              : <Text dimColor> ○</Text>}
          </Text>
        </Box>
      ))
    : <Text dimColor>No friends</Text>}
</PanelBox>
```

- [ ] **Step 5: Update the help text line**

Replace:

```tsx
<Text dimColor>Tab: switch panel  ·  s: search  ·  x: skip  ·  +/-: volume  ·  q: quit TUI</Text>
```

With:

```tsx
<Text dimColor>
  {'Tab: switch panel  ·  s: search  ·  x: skip  ·  +/-: volume  ·  q: quit TUI'}
  {focused === 'friends' && friends.length > 0 ? '  ·  Enter: join room' : ''}
</Text>
```

- [ ] **Step 6: Verify compiles**

```bash
cd packages/client && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Run full server test suite one final time**

```bash
cd packages/server && npm test
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/App.tsx
git commit -m "feat(client): add Friends panel with presence indicators and Enter-to-join"
```

---

## Acceptance Criteria Checklist

- [ ] `aux friend add <username>` sends `friend:add` to server → Task 8
- [ ] Unknown username returns a clear error (`UNKNOWN_USER`) → Tasks 2, 5, 6
- [ ] Friends panel shows online friends and their current room name → Task 9
- [ ] Selecting a friend in the panel joins their room → Task 9, Step 3
- [ ] Presence updates in real-time when a friend joins or leaves a room → Tasks 5, 6
