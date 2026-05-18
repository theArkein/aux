# Named Room Create + Join — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add named room creation and joining to the server, with `aux create <name>` and `aux join <name>` CLI commands.

**Architecture:** Rooms live in an in-memory `Map<string, Room>` stored on `ServerHandle`. The `handleMessage` function receives `rooms` and `wss` so it can broadcast `state:sync` to all room members on join. The CLI client authenticates via token then sends room events directly to the server WebSocket.

**Tech Stack:** TypeScript strict, `node:test`, `ws`, `better-sqlite3` (existing), `tsx` dev runner.

---

## File Structure

| File | Action |
|---|---|
| `packages/server/src/types.ts` | Add `Member`, `Room` interfaces |
| `packages/server/src/rooms.ts` | Create — pure room state operations over `Map<string, Room>` |
| `packages/server/src/ws-handler.ts` | Update — add `rooms` + `wss` params, handle `room:create/join/leave` |
| `packages/server/src/server.ts` | Update — add `rooms` to `ServerHandle`, pass to `handleMessage` |
| `packages/server/__tests__/rooms.test.ts` | Create — unit tests for room state transitions |
| `packages/server/__tests__/ws-rooms.test.ts` | Create — WS integration tests (port 13001) |
| `packages/client/bin/aux.ts` | Update — add `create <name>` and `join <name>` commands |

---

### Task 1: Add Room types

**Files:**
- Modify: `packages/server/src/types.ts`

- [ ] **Step 1: Add Member and Room interfaces**

Replace the contents of `packages/server/src/types.ts` with:

```ts
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

export interface AuthenticatedWs {
  userId?: string;
  username?: string;
}

export interface Member {
  id: string;
  username: string;
}

export interface Room {
  id: string;
  name: string;
  hostId: string;
  members: Member[];
  createdAt: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/types.ts
git commit -m "feat(server): add Member and Room types"
```

---

### Task 2: Create rooms.ts — pure state module

**Files:**
- Create: `packages/server/src/rooms.ts`

- [ ] **Step 1: Write the failing test first (see Task 3)**

Task 3 writes the unit tests. Implement `rooms.ts` to satisfy them. Here is the complete implementation:

- [ ] **Step 2: Create packages/server/src/rooms.ts**

```ts
import { randomUUID } from 'node:crypto';
import type { Room, Member } from './types.js';

const ROOM_NAME_RE = /^[a-z0-9]{3,20}$/;

export function validateRoomName(name: string): void {
  if (!ROOM_NAME_RE.test(name)) {
    throw new Error('INVALID_ROOM_NAME');
  }
}

export function createRoom(rooms: Map<string, Room>, name: string, host: Member): Room {
  validateRoomName(name);
  for (const room of rooms.values()) {
    if (room.name === name) throw new Error('ROOM_NAME_TAKEN');
  }
  const room: Room = {
    id: randomUUID(),
    name,
    hostId: host.id,
    members: [{ id: host.id, username: host.username }],
    createdAt: Date.now(),
  };
  rooms.set(room.id, room);
  return room;
}

export function joinRoom(rooms: Map<string, Room>, roomName: string, member: Member): Room {
  const room = getRoomByName(rooms, roomName);
  if (!room) throw new Error('ROOM_NOT_FOUND');
  if (!room.members.some((m) => m.id === member.id)) {
    room.members.push({ id: member.id, username: member.username });
  }
  return room;
}

export function leaveRoom(rooms: Map<string, Room>, roomId: string, userId: string): Room | null {
  const room = rooms.get(roomId);
  if (!room) return null;
  room.members = room.members.filter((m) => m.id !== userId);
  if (room.members.length === 0) {
    rooms.delete(roomId);
    return null;
  }
  if (room.hostId === userId) {
    room.hostId = room.members[0]!.id;
  }
  return room;
}

export function getRoomByName(rooms: Map<string, Room>, name: string): Room | undefined {
  for (const room of rooms.values()) {
    if (room.name === name) return room;
  }
  return undefined;
}

export function getRoom(rooms: Map<string, Room>, id: string): Room | undefined {
  return rooms.get(id);
}
```

---

### Task 3: Write unit tests for room state transitions

**Files:**
- Create: `packages/server/__tests__/rooms.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Room } from '../src/types.js';
import {
  createRoom,
  joinRoom,
  leaveRoom,
  getRoomByName,
  validateRoomName,
} from '../src/rooms.js';

test('validateRoomName accepts valid names', () => {
  assert.doesNotThrow(() => validateRoomName('apple'));
  assert.doesNotThrow(() => validateRoomName('abc'));
  assert.doesNotThrow(() => validateRoomName('12345678901234567890'));
});

test('validateRoomName rejects invalid names', () => {
  assert.throws(() => validateRoomName('ab'), { message: 'INVALID_ROOM_NAME' });
  assert.throws(() => validateRoomName('a'.repeat(21)), { message: 'INVALID_ROOM_NAME' });
  assert.throws(() => validateRoomName('Hello'), { message: 'INVALID_ROOM_NAME' });
  assert.throws(() => validateRoomName('has space'), { message: 'INVALID_ROOM_NAME' });
  assert.throws(() => validateRoomName('has-dash'), { message: 'INVALID_ROOM_NAME' });
});

test('createRoom creates room with host as first member', () => {
  const rooms = new Map<string, Room>();
  const room = createRoom(rooms, 'apple', { id: 'u1', username: 'alice' });
  assert.equal(room.name, 'apple');
  assert.equal(room.hostId, 'u1');
  assert.equal(room.members.length, 1);
  assert.equal(room.members[0]!.username, 'alice');
  assert.equal(rooms.size, 1);
});

test('createRoom throws ROOM_NAME_TAKEN on duplicate', () => {
  const rooms = new Map<string, Room>();
  createRoom(rooms, 'apple', { id: 'u1', username: 'alice' });
  assert.throws(
    () => createRoom(rooms, 'apple', { id: 'u2', username: 'bob' }),
    { message: 'ROOM_NAME_TAKEN' }
  );
});

test('joinRoom adds member to existing room', () => {
  const rooms = new Map<string, Room>();
  createRoom(rooms, 'apple', { id: 'u1', username: 'alice' });
  const room = joinRoom(rooms, 'apple', { id: 'u2', username: 'bob' });
  assert.equal(room.members.length, 2);
  assert.ok(room.members.some((m) => m.username === 'bob'));
});

test('joinRoom is idempotent for existing member', () => {
  const rooms = new Map<string, Room>();
  createRoom(rooms, 'apple', { id: 'u1', username: 'alice' });
  joinRoom(rooms, 'apple', { id: 'u1', username: 'alice' });
  const room = getRoomByName(rooms, 'apple')!;
  assert.equal(room.members.length, 1);
});

test('joinRoom throws ROOM_NOT_FOUND for unknown room', () => {
  const rooms = new Map<string, Room>();
  assert.throws(
    () => joinRoom(rooms, 'ghost', { id: 'u1', username: 'alice' }),
    { message: 'ROOM_NOT_FOUND' }
  );
});

test('leaveRoom removes member and transfers host on host leave', () => {
  const rooms = new Map<string, Room>();
  const room = createRoom(rooms, 'apple', { id: 'u1', username: 'alice' });
  joinRoom(rooms, 'apple', { id: 'u2', username: 'bob' });
  const updated = leaveRoom(rooms, room.id, 'u1');
  assert.ok(updated !== null);
  assert.equal(updated!.hostId, 'u2');
  assert.equal(updated!.members.length, 1);
});

test('leaveRoom deletes room when last member leaves', () => {
  const rooms = new Map<string, Room>();
  const room = createRoom(rooms, 'apple', { id: 'u1', username: 'alice' });
  const result = leaveRoom(rooms, room.id, 'u1');
  assert.equal(result, null);
  assert.equal(rooms.size, 0);
});
```

- [ ] **Step 2: Run tests**

```bash
cd /path/to/aux
npx tsx --test 'packages/server/__tests__/rooms.test.ts'
```

Expected: all 8 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/rooms.ts packages/server/__tests__/rooms.test.ts
git commit -m "feat(server): room state module + unit tests"
```

---

### Task 4: Update ws-handler.ts — add room event handlers

**Files:**
- Modify: `packages/server/src/ws-handler.ts`

The handler needs `rooms: Map<string, Room>` and `wss: WebSocketServer` to broadcast `state:sync` to all room members on join.

- [ ] **Step 1: Replace packages/server/src/ws-handler.ts**

```ts
import type Database from 'better-sqlite3';
import { WebSocket, type WebSocketServer } from 'ws';
import { registerUser, loginUser, signToken, verifyToken } from './auth.js';
import { createRoom, joinRoom, leaveRoom } from './rooms.js';
import type { User, Room } from './types.js';

interface IncomingWs extends WebSocket {
  userId?: string;
  username?: string;
  roomId?: string;
}

interface AuthMessage {
  event: 'auth';
  action: 'register' | 'login' | 'token';
  username?: string;
  password?: string;
  token?: string;
}

interface RoomCreateMessage {
  event: 'room:create';
  name: string;
}

interface RoomJoinMessage {
  event: 'room:join';
  name: string;
}

interface RoomLeaveMessage {
  event: 'room:leave';
}

function reply(ws: WebSocket, data: object): void {
  ws.send(JSON.stringify(data));
}

function broadcastToRoom(wss: WebSocketServer, room: Room, data: object): void {
  const memberIds = new Set(room.members.map((m) => m.id));
  for (const client of wss.clients) {
    const c = client as IncomingWs;
    if (c.userId && memberIds.has(c.userId) && c.readyState === WebSocket.OPEN) {
      c.send(JSON.stringify(data));
    }
  }
}

function handleAuth(
  db: Database.Database,
  jwtSecret: string,
  ws: IncomingWs,
  msg: AuthMessage
): void {
  try {
    let user: User;

    if (msg.action === 'register') {
      if (!msg.username || !msg.password) {
        reply(ws, { event: 'auth:error', code: 'MISSING_FIELDS' });
        return;
      }
      user = registerUser(db, msg.username, msg.password);
    } else if (msg.action === 'login') {
      if (!msg.username || !msg.password) {
        reply(ws, { event: 'auth:error', code: 'MISSING_FIELDS' });
        return;
      }
      user = loginUser(db, msg.username, msg.password);
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
    } else {
      reply(ws, { event: 'auth:error', code: 'UNKNOWN_ACTION' });
      return;
    }

    const token = signToken(user, jwtSecret);
    ws.userId = user.id;
    ws.username = user.username;
    reply(ws, { event: 'auth:ok', token, username: user.username });
  } catch (err) {
    reply(ws, { event: 'auth:error', code: (err as Error).message });
  }
}

function handleRoomCreate(
  rooms: Map<string, Room>,
  wss: WebSocketServer,
  ws: IncomingWs,
  msg: RoomCreateMessage
): void {
  if (!ws.userId || !ws.username) {
    reply(ws, { event: 'room:error', code: 'UNAUTHENTICATED' });
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

function handleRoomJoin(
  rooms: Map<string, Room>,
  wss: WebSocketServer,
  ws: IncomingWs,
  msg: RoomJoinMessage
): void {
  if (!ws.userId || !ws.username) {
    reply(ws, { event: 'room:error', code: 'UNAUTHENTICATED' });
    return;
  }
  try {
    const room = joinRoom(rooms, msg.name, { id: ws.userId, username: ws.username });
    ws.roomId = room.id;
    broadcastToRoom(wss, room, { event: 'state:sync', room });
  } catch (err) {
    reply(ws, { event: 'room:error', code: (err as Error).message });
  }
}

function handleRoomLeave(
  rooms: Map<string, Room>,
  wss: WebSocketServer,
  ws: IncomingWs
): void {
  if (!ws.userId || !ws.roomId) {
    reply(ws, { event: 'room:error', code: 'NOT_IN_ROOM' });
    return;
  }
  const updated = leaveRoom(rooms, ws.roomId, ws.userId);
  const roomId = ws.roomId;
  ws.roomId = undefined;
  reply(ws, { event: 'room:left' });
  if (updated) {
    broadcastToRoom(wss, updated, { event: 'state:sync', room: updated });
  }
}

export function handleMessage(
  db: Database.Database,
  jwtSecret: string,
  ws: IncomingWs,
  raw: string,
  rooms: Map<string, Room>,
  wss: WebSocketServer
): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    reply(ws, { event: 'error', code: 'BAD_JSON' });
    return;
  }

  if (msg['event'] === 'auth') {
    handleAuth(db, jwtSecret, ws, msg as unknown as AuthMessage);
    return;
  }

  if (msg['event'] === 'room:create') {
    handleRoomCreate(rooms, wss, ws, msg as unknown as RoomCreateMessage);
    return;
  }

  if (msg['event'] === 'room:join') {
    handleRoomJoin(rooms, wss, ws, msg as unknown as RoomJoinMessage);
    return;
  }

  if (msg['event'] === 'room:leave') {
    handleRoomLeave(rooms, wss, ws);
    return;
  }

  reply(ws, { event: 'error', code: 'UNKNOWN_EVENT' });
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/ws-handler.ts
git commit -m "feat(server): add room:create/join/leave event handlers"
```

---

### Task 5: Update server.ts — add rooms to ServerHandle

**Files:**
- Modify: `packages/server/src/server.ts`

- [ ] **Step 1: Update server.ts**

Replace the contents:

```ts
import 'dotenv/config';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { initDb, closeDb } from './db.js';
import { handleMessage } from './ws-handler.js';
import type { Room } from './types.js';
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
}

export async function startServer(opts: ServerOptions = {}): Promise<ServerHandle> {
  const port = opts.port ?? Number(process.env['PORT'] ?? 7700);
  const jwtSecret = opts.jwtSecret ?? process.env['JWT_SECRET'];
  const dbPath = opts.dbPath ?? process.env['DATABASE_PATH'] ?? './aux.db';

  if (!jwtSecret) throw new Error('JWT_SECRET is required');

  const db = initDb(dbPath);
  const rooms = new Map<string, Room>();
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) =>
      handleMessage(db, jwtSecret, ws, raw.toString(), rooms, wss)
    );
    ws.on('error', (err) => console.error('ws error:', err.message));
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  console.log(`aux-server listening on :${port}`);

  return { httpServer, wss, db, rooms };
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

- [ ] **Step 2: Run existing auth tests to ensure nothing broke**

```bash
npx tsx --test 'packages/server/__tests__/auth.test.ts' 'packages/server/__tests__/ws-auth.test.ts'
```

Expected: all 10 existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/server.ts
git commit -m "feat(server): add rooms Map to ServerHandle, thread through handleMessage"
```

---

### Task 6: Write WS integration tests for room events

**Files:**
- Create: `packages/server/__tests__/ws-rooms.test.ts`

Uses port **13001** (auth tests use 13000).

- [ ] **Step 1: Create the test file**

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer, stopServer } from '../src/server.js';
import { registerUser } from '../src/auth.js';
import type { ServerHandle } from '../src/server.js';

const PORT = 13001;
const JWT_SECRET = 'test-secret-rooms';
const URL = `ws://localhost:${PORT}`;

let server: ServerHandle;

before(async () => {
  server = await startServer({ port: PORT, jwtSecret: JWT_SECRET, dbPath: ':memory:' });
  registerUser(server.db, 'alice', 'pass');
  registerUser(server.db, 'bob', 'pass');
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
  await new Promise<void>((resolve) => ws.once('open', resolve));
  send(ws, { event: 'auth', action: 'login', username, password });
  const msg = await waitMsg(ws);
  assert.equal(msg['event'], 'auth:ok');
}

test('room:create returns state:sync with creator as member', async () => {
  const ws = openWs();
  try {
    await authenticate(ws, 'alice', 'pass');
    send(ws, { event: 'room:create', name: 'apple' });
    const msg = await waitMsg(ws);
    assert.equal(msg['event'], 'state:sync');
    const room = msg['room'] as Record<string, unknown>;
    assert.equal(room['name'], 'apple');
    const members = room['members'] as Array<{ username: string }>;
    assert.equal(members.length, 1);
    assert.equal(members[0]!.username, 'alice');
  } finally {
    ws.close();
    await new Promise((r) => ws.once('close', r));
  }
});

test('room:create returns ROOM_NAME_TAKEN on duplicate', async () => {
  const ws = openWs();
  try {
    await authenticate(ws, 'alice', 'pass');
    send(ws, { event: 'room:create', name: 'duproom' });
    await waitMsg(ws); // state:sync
    send(ws, { event: 'room:create', name: 'duproom' });
    const msg = await waitMsg(ws);
    assert.equal(msg['event'], 'room:error');
    assert.equal(msg['code'], 'ROOM_NAME_TAKEN');
  } finally {
    ws.close();
    await new Promise((r) => ws.once('close', r));
  }
});

test('room:create returns INVALID_ROOM_NAME for bad name', async () => {
  const ws = openWs();
  try {
    await authenticate(ws, 'alice', 'pass');
    send(ws, { event: 'room:create', name: 'BAD NAME!' });
    const msg = await waitMsg(ws);
    assert.equal(msg['event'], 'room:error');
    assert.equal(msg['code'], 'INVALID_ROOM_NAME');
  } finally {
    ws.close();
    await new Promise((r) => ws.once('close', r));
  }
});

test('room:join returns state:sync with both members, broadcaster receives update', async () => {
  const wsAlice = openWs();
  const wsBob = openWs();
  try {
    await authenticate(wsAlice, 'alice', 'pass');
    send(wsAlice, { event: 'room:create', name: 'sharedroom' });
    const aliceSync1 = await waitMsg(wsAlice);
    assert.equal(aliceSync1['event'], 'state:sync');

    await authenticate(wsBob, 'bob', 'pass');

    // listen for broadcast to alice before bob joins
    const aliceSyncP = waitMsg(wsAlice);
    send(wsBob, { event: 'room:join', name: 'sharedroom' });
    const [bobSync, aliceSync2] = await Promise.all([waitMsg(wsBob), aliceSyncP]);

    assert.equal(bobSync['event'], 'state:sync');
    assert.equal(aliceSync2['event'], 'state:sync');
    const bobRoom = bobSync['room'] as Record<string, unknown>;
    const aliceRoom = aliceSync2['room'] as Record<string, unknown>;
    const bobMembers = bobRoom['members'] as Array<{ username: string }>;
    const aliceMembers = aliceRoom['members'] as Array<{ username: string }>;
    assert.equal(bobMembers.length, 2);
    assert.equal(aliceMembers.length, 2);
  } finally {
    wsAlice.close();
    wsBob.close();
    await Promise.all([
      new Promise((r) => wsAlice.once('close', r)),
      new Promise((r) => wsBob.once('close', r)),
    ]);
  }
});

test('room:join returns ROOM_NOT_FOUND for unknown room', async () => {
  const ws = openWs();
  try {
    await authenticate(ws, 'bob', 'pass');
    send(ws, { event: 'room:join', name: 'ghost' });
    const msg = await waitMsg(ws);
    assert.equal(msg['event'], 'room:error');
    assert.equal(msg['code'], 'ROOM_NOT_FOUND');
  } finally {
    ws.close();
    await new Promise((r) => ws.once('close', r));
  }
});
```

- [ ] **Step 2: Run the tests**

```bash
npx tsx --test 'packages/server/__tests__/ws-rooms.test.ts'
```

Expected: all 5 tests pass.

- [ ] **Step 3: Run full test suite**

```bash
npx tsx --test 'packages/server/__tests__/*.test.ts'
```

Expected: all 15 tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/server/__tests__/ws-rooms.test.ts
git commit -m "test(server): WS integration tests for room create/join"
```

---

### Task 7: Add `aux create` and `aux join` CLI commands

**Files:**
- Modify: `packages/client/bin/aux.ts`

These commands connect directly to the server WebSocket, authenticate with the stored token, send the room event, and print the result.

- [ ] **Step 1: Replace packages/client/bin/aux.ts**

```ts
#!/usr/bin/env tsx
import { WebSocket } from 'ws';
import { readFileSync, existsSync } from 'node:fs';
import { saveCredentials, loadCredentials } from '../src/credentials.js';

const PID_FILE = '/tmp/aux.pid';
const SERVER_URL = process.env['AUX_SERVER_URL'] ?? 'ws://localhost:7700';

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
    await roomCommand('room:create', { name });
    return;
  }

  if (command === 'join') {
    const [name] = args;
    if (!name) {
      console.error('Usage: aux join <name>');
      process.exit(1);
    }
    await roomCommand('room:join', { name });
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

  console.error(`Unknown command: ${command ?? '(none)'}`);
  console.error('Available commands: register, login, create, join, quit');
  process.exit(1);
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

async function roomCommand(event: 'room:create' | 'room:join', extra: Record<string, string>): Promise<void> {
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
        ws.send(JSON.stringify({ event, ...extra }));
        return;
      }

      if (msg['event'] === 'state:sync') {
        const room = msg['room'] as Record<string, unknown>;
        const members = (room['members'] as Array<{ username: string }>)
          .map((m) => m.username)
          .join(', ');
        console.log(`Room: ${room['name'] as string} (members: ${members})`);
        ws.close();
        resolve();
        return;
      }

      if (msg['event'] === 'room:error' || msg['event'] === 'auth:error') {
        console.error(`Error: ${msg['code'] as string}`);
        ws.close();
        reject(new Error(msg['code'] as string));
      }
    });

    ws.on('error', reject);
  });
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add packages/client/bin/aux.ts
git commit -m "feat(client): add aux create and aux join commands"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run the full server test suite**

```bash
npx tsx --test 'packages/server/__tests__/*.test.ts'
```

Expected: all 15 tests pass (5 auth unit, 5 ws-auth integration, 5 ws-rooms integration).

- [ ] **Step 2: TypeScript type check**

```bash
npm run build --workspace=packages/server
npm run build --workspace=packages/client
```

Expected: no errors.

- [ ] **Step 3: Commit if any fixes needed, then push and PR**

```bash
git push -u origin feature/issue-2-named-rooms
gh pr create --title "feat: named room create + join (#2)" --body "$(cat <<'EOF'
## Summary
- Server: in-memory `Map<string, Room>` room state with create/join/leave operations
- Server: `room:create`, `room:join`, `room:leave` WS events with `state:sync` broadcast
- Room name validation: lowercase alphanumeric, 3–20 chars
- Client: `aux create <name>` and `aux join <name>` CLI commands
- 8 unit tests + 5 WS integration tests

## Test Plan
- [ ] `npx tsx --test 'packages/server/__tests__/*.test.ts'` — 15 tests pass
- [ ] `npm run build --workspaces` — no TypeScript errors
- [ ] `aux create apple` creates a room when logged in
- [ ] `aux join apple` joins an existing room

Closes #2
EOF
)"
```
