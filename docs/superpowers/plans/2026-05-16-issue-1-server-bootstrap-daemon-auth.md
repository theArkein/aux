# Issue #1: Server Bootstrap + Daemon Auth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the TypeScript WebSocket server with user registration/login (JWT + bcrypt), and wire the daemon to connect and authenticate — end-to-end auth flow working locally.

**Architecture:** Stateful server owns user accounts in SQLite. Clients authenticate over WebSocket by sending an `auth` event with credentials; the server responds with a JWT. The daemon stores credentials locally in `~/.aux/credentials.json` and reconnects automatically with its JWT. The daemon also opens a Unix socket at `/tmp/aux.sock` for the TUI to attach to later.

**Tech Stack:** TypeScript (strict), Node.js 20+, `tsx` (dev runner), `ws`, `better-sqlite3`, `bcryptjs`, `jsonwebtoken`, `node:test`

---

## File Map

### Root (monorepo)
```
tsconfig.base.json        # base TS config all packages extend
```

### `packages/server`
```
packages/server/
├── package.json
├── tsconfig.json          # extends ../../tsconfig.base.json
├── .env.example
├── src/
│   ├── types.ts           # shared interfaces: User, WsClient
│   ├── db.ts              # SQLite connection + schema migration
│   ├── auth.ts            # registerUser(), loginUser(), signToken(), verifyToken()
│   ├── ws-handler.ts      # routes incoming WS messages to handlers
│   └── server.ts          # entry point: HTTP + WebSocket server, startServer(), stopServer()
└── __tests__/
    ├── auth.test.ts       # unit tests for register/login/verifyToken
    └── ws-auth.test.ts    # integration: WS client sends auth, gets JWT back
```

### `packages/daemon`
```
packages/daemon/
├── package.json
├── tsconfig.json
├── src/
│   ├── credentials.ts     # saveCredentials(), loadCredentials(), clearCredentials()
│   ├── ws-client.ts       # manages WS connection to server, auto-reconnect
│   └── ipc-server.ts      # Unix socket at /tmp/aux.sock for TUI
├── bin/
│   └── auxd.ts            # entry point: daemon main, PID file at /tmp/aux.pid
└── __tests__/
    └── credentials.test.ts
```

### `packages/client`
```
packages/client/
├── package.json
├── tsconfig.json
└── bin/
    └── aux.ts             # entry point: register/login/quit commands
```

---

## Task 1: Root TypeScript config + server package scaffold

**Files:**
- Create: `tsconfig.base.json`
- Create: `packages/server/package.json`
- Create: `packages/server/tsconfig.json`
- Create: `packages/server/.env.example`

- [ ] **Step 1: Create root `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 2: Create `packages/server/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src/**/*", "__tests__/**/*", "bin/**/*"]
}
```

- [ ] **Step 3: Create `packages/server/package.json`**

```json
{
  "name": "@aux/server",
  "version": "0.1.0",
  "scripts": {
    "start": "node dist/src/server.js",
    "dev": "tsx watch src/server.ts",
    "build": "tsc",
    "test": "tsx --test '__tests__/**/*.test.ts'"
  },
  "dependencies": {
    "ws": "^8.18.0",
    "better-sqlite3": "^11.5.0",
    "bcryptjs": "^2.4.3",
    "jsonwebtoken": "^9.0.2",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.13",
    "@types/better-sqlite3": "^7.6.12",
    "@types/bcryptjs": "^2.4.6",
    "@types/jsonwebtoken": "^9.0.7"
  }
}
```

- [ ] **Step 4: Create `packages/server/.env.example`**

```
PORT=7700
JWT_SECRET=change-me-in-production
DATABASE_PATH=./aux.db
```

- [ ] **Step 5: Install server dependencies**

Run from repo root:
```bash
npm install --workspace=packages/server
```

Expected: no errors, `packages/server/node_modules` created.

- [ ] **Step 6: Create `packages/server/src/` directory and verify tsc compiles**

```bash
mkdir -p packages/server/src packages/server/__tests__
touch packages/server/src/server.ts
npm run build --workspace=packages/server 2>&1 || true
```

Expected: may warn about empty file, that's fine.

- [ ] **Step 7: Commit**

```bash
git add tsconfig.base.json packages/server/package.json packages/server/tsconfig.json packages/server/.env.example package-lock.json
git commit -m "feat(server): TypeScript scaffold and dependencies"
```

---

## Task 2: Server — types + SQLite schema

**Files:**
- Create: `packages/server/src/types.ts`
- Create: `packages/server/src/db.ts`
- Create: `packages/server/__tests__/auth.test.ts` (failing scaffold)

- [ ] **Step 1: Write the failing test scaffold**

Create `packages/server/__tests__/auth.test.ts`:

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../src/db.js';
import { registerUser, loginUser } from '../src/auth.js';
import type { Database } from 'better-sqlite3';

let db: Database;

before(() => {
  db = initDb(':memory:');
});

after(() => {
  closeDb(db);
});

test('registerUser creates a new user and returns the user row', () => {
  const user = registerUser(db, 'alice', 'password123');
  assert.equal(user.username, 'alice');
  assert.ok(user.id, 'user should have an id');
  assert.ok(!('passwordHash' in user), 'passwordHash must not be returned');
});

test('registerUser throws if username is already taken', () => {
  registerUser(db, 'bob', 'pass');
  assert.throws(
    () => registerUser(db, 'bob', 'otherpass'),
    { message: 'USERNAME_TAKEN' }
  );
});

test('loginUser returns user row on correct password', () => {
  registerUser(db, 'carol', 'secret');
  const user = loginUser(db, 'carol', 'secret');
  assert.equal(user.username, 'carol');
  assert.ok(!('passwordHash' in user), 'passwordHash must not be returned');
});

test('loginUser throws on wrong password', () => {
  registerUser(db, 'dave', 'rightpass');
  assert.throws(
    () => loginUser(db, 'dave', 'wrongpass'),
    { message: 'INVALID_CREDENTIALS' }
  );
});

test('loginUser throws on unknown username', () => {
  assert.throws(
    () => loginUser(db, 'nobody', 'pass'),
    { message: 'INVALID_CREDENTIALS' }
  );
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npm test --workspace=packages/server
```

Expected: FAIL — `Cannot find module '../src/db.js'`

- [ ] **Step 3: Create `packages/server/src/types.ts`**

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
```

- [ ] **Step 4: Create `packages/server/src/db.ts`**

```ts
import Database from 'better-sqlite3';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    username     TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;

export function initDb(path: string): Database.Database {
  const db = new Database(path);
  db.exec(SCHEMA);
  return db;
}

export function closeDb(db: Database.Database): void {
  db.close();
}
```

- [ ] **Step 5: Run tests — verify they still fail (auth.ts missing)**

```bash
npm test --workspace=packages/server
```

Expected: FAIL — `Cannot find module '../src/auth.js'`

---

## Task 3: Server — auth module

**Files:**
- Create: `packages/server/src/auth.ts`

- [ ] **Step 1: Create `packages/server/src/auth.ts`**

```ts
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type Database from 'better-sqlite3';
import type { User, UserRow } from './types.js';

const SALT_ROUNDS = 10;

export function registerUser(db: Database.Database, username: string, password: string): User {
  const existing = db.prepare<[string], Pick<UserRow, 'id'>>('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) throw new Error('USERNAME_TAKEN');

  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
  const id = randomUUID();

  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(id, username, passwordHash);

  return { id, username };
}

export function loginUser(db: Database.Database, username: string, password: string): User {
  const row = db.prepare<[string], UserRow>('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
  if (!row) throw new Error('INVALID_CREDENTIALS');

  const match = bcrypt.compareSync(password, row.password_hash);
  if (!match) throw new Error('INVALID_CREDENTIALS');

  return { id: row.id, username: row.username };
}

export function signToken(payload: User, secret: string): string {
  return jwt.sign(payload, secret, { expiresIn: '30d' });
}

export function verifyToken(token: string, secret: string): User {
  return jwt.verify(token, secret) as User;
}
```

- [ ] **Step 2: Run tests — expect all 5 to pass**

```bash
npm test --workspace=packages/server
```

Expected: All 5 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/types.ts packages/server/src/db.ts packages/server/src/auth.ts packages/server/__tests__/auth.test.ts
git commit -m "feat(server): SQLite schema, types, and auth module (register/login/JWT)"
```

---

## Task 4: Server — WebSocket integration tests

**Files:**
- Create: `packages/server/__tests__/ws-auth.test.ts`

- [ ] **Step 1: Write the failing integration tests**

Create `packages/server/__tests__/ws-auth.test.ts`:

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer, stopServer, type ServerHandle } from '../src/server.js';

const PORT = 13000;
const JWT_SECRET = 'test-secret';
let server: ServerHandle;

before(async () => {
  server = await startServer({ port: PORT, jwtSecret: JWT_SECRET, dbPath: ':memory:' });
});

after(async () => {
  await stopServer(server);
});

function wsConnect(): Promise<WebSocket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.on('open', () => resolve(ws));
  });
}

function send(ws: WebSocket, data: object): void {
  ws.send(JSON.stringify(data));
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => ws.once('message', (raw) => resolve(JSON.parse(raw.toString()))));
}

test('auth:register — new user gets a JWT back', async () => {
  const ws = await wsConnect();
  send(ws, { event: 'auth', action: 'register', username: 'alice', password: 'pass123' });
  const msg = await nextMessage(ws);
  assert.equal(msg['event'], 'auth:ok');
  assert.ok(typeof msg['token'] === 'string', 'token must be a string');
  assert.equal(msg['username'], 'alice');
  ws.close();
});

test('auth:register — duplicate username returns error', async () => {
  const ws = await wsConnect();
  send(ws, { event: 'auth', action: 'register', username: 'bob', password: 'pass' });
  await nextMessage(ws);

  const ws2 = await wsConnect();
  send(ws2, { event: 'auth', action: 'register', username: 'bob', password: 'other' });
  const msg = await nextMessage(ws2);
  assert.equal(msg['event'], 'auth:error');
  assert.equal(msg['code'], 'USERNAME_TAKEN');
  ws.close();
  ws2.close();
});

test('auth:login — correct credentials return a JWT', async () => {
  const ws = await wsConnect();
  send(ws, { event: 'auth', action: 'register', username: 'carol', password: 'secret' });
  await nextMessage(ws);
  ws.close();

  const ws2 = await wsConnect();
  send(ws2, { event: 'auth', action: 'login', username: 'carol', password: 'secret' });
  const msg = await nextMessage(ws2);
  assert.equal(msg['event'], 'auth:ok');
  assert.ok(typeof msg['token'] === 'string');
  ws2.close();
});

test('auth:login — wrong password returns error', async () => {
  const ws = await wsConnect();
  send(ws, { event: 'auth', action: 'register', username: 'dave', password: 'right' });
  await nextMessage(ws);
  ws.close();

  const ws2 = await wsConnect();
  send(ws2, { event: 'auth', action: 'login', username: 'dave', password: 'wrong' });
  const msg = await nextMessage(ws2);
  assert.equal(msg['event'], 'auth:error');
  assert.equal(msg['code'], 'INVALID_CREDENTIALS');
  ws2.close();
});

test('auth:token — valid JWT re-authenticates the connection', async () => {
  const ws = await wsConnect();
  send(ws, { event: 'auth', action: 'register', username: 'eve', password: 'pw' });
  const { token } = await nextMessage(ws) as { token: string };
  ws.close();

  const ws2 = await wsConnect();
  send(ws2, { event: 'auth', action: 'token', token });
  const msg = await nextMessage(ws2);
  assert.equal(msg['event'], 'auth:ok');
  assert.equal(msg['username'], 'eve');
  ws2.close();
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npm test --workspace=packages/server
```

Expected: FAIL — `Cannot find module '../src/server.js'`

---

## Task 5: Server — ws-handler + server entry point

**Files:**
- Create: `packages/server/src/ws-handler.ts`
- Create: `packages/server/src/server.ts`

- [ ] **Step 1: Create `packages/server/src/ws-handler.ts`**

```ts
import type Database from 'better-sqlite3';
import type WebSocket from 'ws';
import { registerUser, loginUser, signToken, verifyToken } from './auth.js';
import type { User } from './types.js';

interface IncomingWs extends WebSocket {
  userId?: string;
  username?: string;
}

interface AuthMessage {
  event: 'auth';
  action: 'register' | 'login' | 'token';
  username?: string;
  password?: string;
  token?: string;
}

function reply(ws: WebSocket, data: object): void {
  ws.send(JSON.stringify(data));
}

function handleAuth(db: Database.Database, jwtSecret: string, ws: IncomingWs, msg: AuthMessage): void {
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

export function handleMessage(db: Database.Database, jwtSecret: string, ws: IncomingWs, raw: string): void {
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

  reply(ws, { event: 'error', code: 'UNKNOWN_EVENT' });
}
```

- [ ] **Step 2: Create `packages/server/src/server.ts`**

```ts
import 'dotenv/config';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { initDb, closeDb } from './db.js';
import { handleMessage } from './ws-handler.js';
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
}

export async function startServer(opts: ServerOptions = {}): Promise<ServerHandle> {
  const port = opts.port ?? Number(process.env['PORT'] ?? 7700);
  const jwtSecret = opts.jwtSecret ?? process.env['JWT_SECRET'];
  const dbPath = opts.dbPath ?? process.env['DATABASE_PATH'] ?? './aux.db';

  if (!jwtSecret) throw new Error('JWT_SECRET is required');

  const db = initDb(dbPath);
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => handleMessage(db, jwtSecret, ws, raw.toString()));
    ws.on('error', (err) => console.error('ws error:', err.message));
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  console.log(`aux-server listening on :${port}`);

  return { httpServer, wss, db };
}

export async function stopServer({ httpServer, wss, db }: ServerHandle): Promise<void> {
  wss.close();
  closeDb(db);
  await new Promise<void>((resolve, reject) => httpServer.close((err) => err ? reject(err) : resolve()));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  startServer().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
```

- [ ] **Step 3: Run all server tests — expect all 10 to pass**

```bash
npm test --workspace=packages/server
```

Expected: All 10 tests PASS (5 unit + 5 WS integration).

- [ ] **Step 4: Verify TypeScript compiles cleanly**

```bash
npm run build --workspace=packages/server
```

Expected: No TypeScript errors, `dist/` directory created.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/ws-handler.ts packages/server/src/server.ts packages/server/__tests__/ws-auth.test.ts
git commit -m "feat(server): WebSocket server with auth (register/login/token)"
```

---

## Task 6: Daemon — package scaffold + TypeScript config

**Files:**
- Create: `packages/daemon/package.json`
- Create: `packages/daemon/tsconfig.json`

- [ ] **Step 1: Create `packages/daemon/package.json`**

```json
{
  "name": "@aux/daemon",
  "version": "0.1.0",
  "bin": {
    "auxd": "./bin/auxd.ts"
  },
  "scripts": {
    "start": "node dist/bin/auxd.js",
    "dev": "tsx bin/auxd.ts",
    "build": "tsc",
    "test": "tsx --test '__tests__/**/*.test.ts'"
  },
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.13"
  }
}
```

- [ ] **Step 2: Create `packages/daemon/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src/**/*", "__tests__/**/*", "bin/**/*"]
}
```

- [ ] **Step 3: Install daemon dependencies**

```bash
npm install --workspace=packages/daemon
```

Expected: no errors.

- [ ] **Step 4: Create source directories**

```bash
mkdir -p packages/daemon/src packages/daemon/__tests__ packages/daemon/bin
```

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/package.json packages/daemon/tsconfig.json package-lock.json
git commit -m "feat(daemon): TypeScript scaffold and dependencies"
```

---

## Task 7: Daemon — credential storage

**Files:**
- Create: `packages/daemon/__tests__/credentials.test.ts`
- Create: `packages/daemon/src/credentials.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/__tests__/credentials.test.ts`:

```ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveCredentials, loadCredentials, clearCredentials } from '../src/credentials.js';

const testDir = join(tmpdir(), `aux-test-${Date.now()}`);

before(() => mkdirSync(testDir, { recursive: true }));
after(() => rmSync(testDir, { recursive: true, force: true }));

test('saveCredentials writes token and username to file', () => {
  saveCredentials({ token: 'tok123', username: 'alice', dir: testDir });
  const creds = loadCredentials({ dir: testDir });
  assert.equal(creds?.token, 'tok123');
  assert.equal(creds?.username, 'alice');
});

test('loadCredentials returns null when file does not exist', () => {
  const emptyDir = join(testDir, 'empty');
  mkdirSync(emptyDir);
  const creds = loadCredentials({ dir: emptyDir });
  assert.equal(creds, null);
});

test('clearCredentials removes the credentials file', () => {
  const clearDir = join(testDir, 'clear');
  mkdirSync(clearDir);
  saveCredentials({ token: 'tok', username: 'bob', dir: clearDir });
  clearCredentials({ dir: clearDir });
  const creds = loadCredentials({ dir: clearDir });
  assert.equal(creds, null);
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npm test --workspace=packages/daemon
```

Expected: FAIL — `Cannot find module '../src/credentials.js'`

- [ ] **Step 3: Create `packages/daemon/src/credentials.ts`**

```ts
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface Credentials {
  token: string;
  username: string;
}

interface CredentialsOptions {
  dir?: string;
}

const DEFAULT_DIR = join(homedir(), '.aux');

function credPath(dir?: string): string {
  return join(dir ?? DEFAULT_DIR, 'credentials.json');
}

export function saveCredentials({ token, username, dir }: Credentials & CredentialsOptions): void {
  const dirPath = dir ?? DEFAULT_DIR;
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(credPath(dirPath), JSON.stringify({ token, username }), 'utf8');
}

export function loadCredentials({ dir }: CredentialsOptions = {}): Credentials | null {
  const path = credPath(dir ?? DEFAULT_DIR);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Credentials;
  } catch {
    return null;
  }
}

export function clearCredentials({ dir }: CredentialsOptions = {}): void {
  const path = credPath(dir ?? DEFAULT_DIR);
  if (existsSync(path)) rmSync(path);
}
```

- [ ] **Step 4: Run tests — expect all 3 to pass**

```bash
npm test --workspace=packages/daemon
```

Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/__tests__/credentials.test.ts packages/daemon/src/credentials.ts
git commit -m "feat(daemon): credential storage (save/load/clear)"
```

---

## Task 8: Daemon — WebSocket client + IPC server + entry point

**Files:**
- Create: `packages/daemon/src/ws-client.ts`
- Create: `packages/daemon/src/ipc-server.ts`
- Create: `packages/daemon/bin/auxd.ts`

- [ ] **Step 1: Create `packages/daemon/src/ws-client.ts`**

```ts
import { WebSocket } from 'ws';

const RECONNECT_DELAY_MS = 3000;

export interface WsClientOptions {
  serverUrl: string;
  onMessage?: (msg: Record<string, unknown>, ws: WebSocket) => void;
  onConnected?: (ws: WebSocket) => void;
}

export interface WsClientHandle {
  send(data: object): void;
  stop(): void;
}

export function createWsClient({ serverUrl, onMessage, onConnected }: WsClientOptions): WsClientHandle {
  let ws: WebSocket | null = null;
  let stopped = false;

  function connect(): void {
    ws = new WebSocket(serverUrl);

    ws.on('open', () => {
      console.log('[daemon] connected to server');
      onConnected?.(ws!);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        onMessage?.(msg, ws!);
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      if (stopped) return;
      console.log(`[daemon] disconnected — retrying in ${RECONNECT_DELAY_MS}ms`);
      setTimeout(connect, RECONNECT_DELAY_MS);
    });

    ws.on('error', (err) => {
      console.error('[daemon] ws error:', err.message);
    });
  }

  connect();

  return {
    send(data: object): void {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    },
    stop(): void {
      stopped = true;
      ws?.close();
    },
  };
}
```

- [ ] **Step 2: Create `packages/daemon/src/ipc-server.ts`**

```ts
import { createServer, type Server, type Socket } from 'node:net';
import { rmSync, existsSync } from 'node:fs';

export const IPC_PATH = '/tmp/aux.sock';

export interface IpcServerOptions {
  onConnection?: (socket: Socket) => void;
}

export function createIpcServer({ onConnection }: IpcServerOptions = {}): Server {
  if (existsSync(IPC_PATH)) rmSync(IPC_PATH);

  const server = createServer((socket) => {
    console.log('[daemon] TUI client connected');
    onConnection?.(socket);

    socket.on('data', (raw) => {
      for (const line of raw.toString().split('\n').filter(Boolean)) {
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          socket.emit('message', msg);
        } catch {
          // ignore malformed lines
        }
      }
    });

    socket.on('end', () => console.log('[daemon] TUI client disconnected'));
    socket.on('error', (err) => console.error('[daemon] IPC socket error:', err.message));
  });

  server.listen(IPC_PATH, () => console.log(`[daemon] IPC socket at ${IPC_PATH}`));
  return server;
}
```

- [ ] **Step 3: Create `packages/daemon/bin/auxd.ts`**

```ts
#!/usr/bin/env tsx
import { writeFileSync, rmSync } from 'node:fs';
import type { Socket } from 'node:net';
import { loadCredentials } from '../src/credentials.js';
import { createWsClient } from '../src/ws-client.js';
import { createIpcServer } from '../src/ipc-server.js';

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

createIpcServer({
  onConnection(socket) {
    tuiClients.add(socket);
    socket.on('end', () => tuiClients.delete(socket));
    socket.on('error', () => tuiClients.delete(socket));
  },
});

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

console.log(`[auxd] running (pid ${process.pid})`);
```

- [ ] **Step 4: Run daemon tests — all should still pass**

```bash
npm test --workspace=packages/daemon
```

Expected: All 3 credentials tests PASS.

- [ ] **Step 5: Verify TypeScript compiles cleanly**

```bash
npm run build --workspace=packages/daemon
```

Expected: No TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/ws-client.ts packages/daemon/src/ipc-server.ts packages/daemon/bin/auxd.ts
git commit -m "feat(daemon): WebSocket client, IPC server, and auxd entry point"
```

---

## Task 9: Client — package scaffold + aux entry point

**Files:**
- Create: `packages/client/package.json`
- Create: `packages/client/tsconfig.json`
- Create: `packages/client/bin/aux.ts`

- [ ] **Step 1: Create `packages/client/package.json`**

```json
{
  "name": "@aux/client",
  "version": "0.1.0",
  "bin": {
    "aux": "./bin/aux.ts"
  },
  "scripts": {
    "start": "node dist/bin/aux.js",
    "dev": "tsx bin/aux.ts",
    "build": "tsc"
  },
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.13"
  }
}
```

- [ ] **Step 2: Create `packages/client/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["bin/**/*", "src/**/*"]
}
```

- [ ] **Step 3: Create `packages/client/bin/` directory**

```bash
mkdir -p packages/client/bin
```

- [ ] **Step 4: Create `packages/client/bin/aux.ts`**

```ts
#!/usr/bin/env tsx
import { WebSocket } from 'ws';
import { readFileSync, existsSync } from 'node:fs';
import { saveCredentials } from '../../daemon/src/credentials.js';

const IPC_PATH = '/tmp/aux.sock';
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
  console.error('Available commands: register, login, quit');
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

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 5: Install client dependencies**

```bash
npm install --workspace=packages/client
```

- [ ] **Step 6: Verify TypeScript compiles cleanly**

```bash
npm run build --workspace=packages/client
```

Expected: No TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add packages/client/package.json packages/client/tsconfig.json packages/client/bin/aux.ts package-lock.json
git commit -m "feat(client): aux CLI entry point with register/login/quit (TypeScript)"
```

---

## Task 10: Final integration + root build script

**Files:**
- Modify: `package.json` (root)

- [ ] **Step 1: Update root `package.json` with build script**

```json
{
  "name": "aux",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "test": "npm test --workspaces --if-present",
    "build": "npm run build --workspaces --if-present",
    "dev:server": "npm run dev --workspace=packages/server"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Run all tests across all workspaces**

```bash
npm test
```

Expected: All 13 tests pass (5 server unit + 5 server WS integration + 3 daemon credentials).

- [ ] **Step 3: Build all packages**

```bash
npm run build
```

Expected: All packages compile without TypeScript errors. `dist/` directories created in each package.

- [ ] **Step 4: End-to-end smoke test**

In terminal 1 — start server:
```bash
cd packages/server && JWT_SECRET=dev tsx src/server.ts
```

Expected: `aux-server listening on :7700`

In terminal 2 — register and login:
```bash
AUX_SERVER_URL=ws://localhost:7700 tsx packages/client/bin/aux.ts register smoketest Pass123!
# Expected: Logged in as smoketest

AUX_SERVER_URL=ws://localhost:7700 tsx packages/client/bin/aux.ts login smoketest Pass123!
# Expected: Logged in as smoketest

cat ~/.aux/credentials.json
# Expected: {"token":"<jwt>","username":"smoketest"}
```

In terminal 3 — start daemon and verify it authenticates:
```bash
AUX_SERVER_URL=ws://localhost:7700 tsx packages/daemon/bin/auxd.ts
# Expected: [daemon] connected to server
# (daemon reads stored token and sends auth:token to server)
```

- [ ] **Step 5: Update `.gitignore` to exclude build output and db files**

Append to `.gitignore`:
```
dist/
*.db
```

- [ ] **Step 6: Final commit**

```bash
git add package.json .gitignore
git commit -m "chore: root build script and gitignore dist + db files"
```

---

## Self-Review

**Spec coverage:**
- ✅ TypeScript throughout (strict mode, tsconfig per package)
- ✅ Server starts and accepts WebSocket connections
- ✅ Register with username + password (bcrypt hashed)
- ✅ Login with username + password → JWT
- ✅ Reconnect with JWT token (`auth:token` action)
- ✅ Daemon connects to server and authenticates on reconnect with stored token
- ✅ Daemon exposes Unix socket at `/tmp/aux.sock` for TUI (IPC)
- ✅ `aux register` / `aux login` CLI commands
- ✅ `aux quit` stops the daemon via PID file
- ✅ Credentials persisted to `~/.aux/credentials.json`
- ✅ Tests: unit (auth logic) + integration (WS auth flow) + unit (credentials)

**Placeholder scan:** None found. All steps include actual TypeScript code.

**Type consistency:**
- `registerUser(db: Database.Database, username: string, password: string): User` — consistent ✅
- `signToken(payload: User, secret: string): string` / `verifyToken(token: string, secret: string): User` — consistent ✅
- `startServer(opts: ServerOptions): Promise<ServerHandle>` / `stopServer(handle: ServerHandle): Promise<void>` — consistent ✅
- `saveCredentials({ token, username, dir })` / `loadCredentials({ dir }): Credentials | null` — consistent ✅
- `createWsClient(opts: WsClientOptions): WsClientHandle` — consistent ✅
- `createIpcServer(opts: IpcServerOptions): Server` — consistent ✅
- `UserRow` interface fields use `snake_case` matching SQLite column names — consistent ✅
