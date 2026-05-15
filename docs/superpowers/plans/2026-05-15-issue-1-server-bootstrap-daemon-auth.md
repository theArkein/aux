# Issue #1: Server Bootstrap + Daemon Auth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the WebSocket server with user registration/login (JWT + bcrypt), and wire the daemon to connect and authenticate — end-to-end auth flow working locally.

**Architecture:** Stateful server owns user accounts in SQLite. Clients authenticate over WebSocket by sending an `auth` event with credentials; the server responds with a JWT. The daemon stores credentials locally in `~/.aux/credentials.json` and reconnects automatically with its JWT. The daemon also opens a Unix socket at `/tmp/aux.sock` for the TUI to attach to later.

**Tech Stack:** Node.js 20+, `ws`, `better-sqlite3`, `bcryptjs`, `jsonwebtoken`, `node:test`

---

## File Map

### `packages/server`
```
packages/server/
├── package.json
├── .env.example
├── server.js            # entry point: HTTP + WebSocket server
├── db.js                # SQLite connection + schema migration
├── auth.js              # register(), login(), verifyToken() — pure functions, no WS
├── ws-handler.js        # routes incoming WS messages to handlers
└── __tests__/
    ├── auth.test.js     # unit tests for register/login/verifyToken
    └── ws-auth.test.js  # integration: WS client sends auth, gets JWT back
```

### `packages/daemon`
```
packages/daemon/
├── package.json
├── bin/
│   └── auxd.js          # entry point: spawns daemon, PID file at /tmp/aux.pid
├── ws-client.js         # manages WS connection to server, auto-reconnect
├── credentials.js       # read/write ~/.aux/credentials.json
├── ipc-server.js        # Unix socket at /tmp/aux.sock for TUI
└── __tests__/
    └── credentials.test.js  # unit tests for credential read/write
```

### `packages/client`
```
packages/client/
├── package.json
└── bin/
    └── aux.js           # entry point: starts daemon if not running, then attaches
```

---

## Task 1: Server — package.json + dependencies

**Files:**
- Create: `packages/server/package.json`
- Create: `packages/server/.env.example`

- [ ] **Step 1: Create `packages/server/package.json`**

```json
{
  "name": "@aux/server",
  "version": "0.1.0",
  "type": "module",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js",
    "test": "node --test __tests__/**/*.test.js"
  },
  "dependencies": {
    "ws": "^8.18.0",
    "better-sqlite3": "^11.5.0",
    "bcryptjs": "^2.4.3",
    "jsonwebtoken": "^9.0.2",
    "dotenv": "^16.4.5"
  }
}
```

- [ ] **Step 2: Create `packages/server/.env.example`**

```
PORT=3000
JWT_SECRET=change-me-in-production
DATABASE_PATH=./aux.db
```

- [ ] **Step 3: Install server dependencies**

Run from repo root:
```bash
npm install --workspace=packages/server
```

Expected: `packages/server/node_modules` created, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/server/package.json packages/server/.env.example package.json package-lock.json
git commit -m "feat(server): add package.json and dependencies"
```

---

## Task 2: Server — SQLite schema

**Files:**
- Create: `packages/server/db.js`
- Create: `packages/server/__tests__/auth.test.js` (scaffolding, will fail)

- [ ] **Step 1: Write the failing test scaffold**

Create `packages/server/__tests__/auth.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../db.js';
import { registerUser, loginUser } from '../auth.js';

let db;

before(() => {
  // Use in-memory SQLite for tests
  db = initDb(':memory:');
});

after(() => {
  closeDb(db);
});

test('registerUser creates a new user and returns the user row', () => {
  const user = registerUser(db, 'alice', 'password123');
  assert.equal(user.username, 'alice');
  assert.ok(user.id, 'user should have an id');
  assert.ok(!user.passwordHash, 'passwordHash must not be returned');
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
  assert.ok(!user.passwordHash, 'passwordHash must not be returned');
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

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test --workspace=packages/server
```

Expected: FAIL — `Cannot find module '../db.js'`

- [ ] **Step 3: Create `packages/server/db.js`**

```js
import Database from 'better-sqlite3';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id        TEXT PRIMARY KEY,
    username  TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;

export function initDb(path) {
  const db = new Database(path);
  db.exec(SCHEMA);
  return db;
}

export function closeDb(db) {
  db.close();
}
```

- [ ] **Step 4: Run tests to verify they still fail (auth.js missing)**

```bash
npm test --workspace=packages/server
```

Expected: FAIL — `Cannot find module '../auth.js'`

---

## Task 3: Server — auth module (register + login)

**Files:**
- Create: `packages/server/auth.js`

- [ ] **Step 1: Create `packages/server/auth.js`**

```js
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const SALT_ROUNDS = 10;

export function registerUser(db, username, password) {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) throw new Error('USERNAME_TAKEN');

  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
  const id = randomUUID();

  db.prepare(
    'INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)'
  ).run(id, username, passwordHash);

  return { id, username };
}

export function loginUser(db, username, password) {
  const row = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
  if (!row) throw new Error('INVALID_CREDENTIALS');

  const match = bcrypt.compareSync(password, row.password_hash);
  if (!match) throw new Error('INVALID_CREDENTIALS');

  return { id: row.id, username: row.username };
}

export function signToken(payload, secret) {
  return jwt.sign(payload, secret, { expiresIn: '30d' });
}

export function verifyToken(token, secret) {
  return jwt.verify(token, secret); // throws on invalid/expired
}
```

- [ ] **Step 2: Run tests — expect all auth tests to pass**

```bash
npm test --workspace=packages/server
```

Expected: All 5 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/server/db.js packages/server/auth.js packages/server/__tests__/auth.test.js
git commit -m "feat(server): add SQLite schema and auth module (register/login/JWT)"
```

---

## Task 4: Server — WebSocket integration test

**Files:**
- Create: `packages/server/__tests__/ws-auth.test.js`
- Create: `packages/server/ws-handler.js` (scaffolding)
- Create: `packages/server/server.js` (scaffolding)

- [ ] **Step 1: Write the failing WS integration test**

Create `packages/server/__tests__/ws-auth.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer, stopServer } from '../server.js';

const PORT = 13000; // test-only port
const JWT_SECRET = 'test-secret';
let server;

before(async () => {
  server = await startServer({ port: PORT, jwtSecret: JWT_SECRET, dbPath: ':memory:' });
});

after(async () => {
  await stopServer(server);
});

function wsConnect() {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    ws.on('open', () => resolve(ws));
  });
}

function send(ws, data) {
  ws.send(JSON.stringify(data));
}

function nextMessage(ws) {
  return new Promise((resolve) => ws.once('message', (raw) => resolve(JSON.parse(raw))));
}

test('auth:register — new user gets a JWT back', async () => {
  const ws = await wsConnect();
  send(ws, { event: 'auth', action: 'register', username: 'alice', password: 'pass123' });
  const msg = await nextMessage(ws);
  assert.equal(msg.event, 'auth:ok');
  assert.ok(typeof msg.token === 'string', 'token must be a string');
  assert.equal(msg.username, 'alice');
  ws.close();
});

test('auth:register — duplicate username returns error', async () => {
  const ws = await wsConnect();
  send(ws, { event: 'auth', action: 'register', username: 'bob', password: 'pass' });
  await nextMessage(ws); // auth:ok

  const ws2 = await wsConnect();
  send(ws2, { event: 'auth', action: 'register', username: 'bob', password: 'other' });
  const msg = await nextMessage(ws2);
  assert.equal(msg.event, 'auth:error');
  assert.equal(msg.code, 'USERNAME_TAKEN');
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
  assert.equal(msg.event, 'auth:ok');
  assert.ok(typeof msg.token === 'string');
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
  assert.equal(msg.event, 'auth:error');
  assert.equal(msg.code, 'INVALID_CREDENTIALS');
  ws2.close();
});

test('auth:token — valid JWT authenticates the connection', async () => {
  // Register first
  const ws = await wsConnect();
  send(ws, { event: 'auth', action: 'register', username: 'eve', password: 'pw' });
  const { token } = await nextMessage(ws);
  ws.close();

  // Reconnect with token
  const ws2 = await wsConnect();
  send(ws2, { event: 'auth', action: 'token', token });
  const msg = await nextMessage(ws2);
  assert.equal(msg.event, 'auth:ok');
  assert.equal(msg.username, 'eve');
  ws2.close();
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npm test --workspace=packages/server
```

Expected: FAIL — `Cannot find module '../server.js'`

---

## Task 5: Server — ws-handler + server entry point

**Files:**
- Create: `packages/server/ws-handler.js`
- Create: `packages/server/server.js`

- [ ] **Step 1: Create `packages/server/ws-handler.js`**

```js
import { registerUser, loginUser, signToken, verifyToken } from './auth.js';

export function handleMessage(db, jwtSecret, ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    ws.send(JSON.stringify({ event: 'error', code: 'BAD_JSON' }));
    return;
  }

  if (msg.event === 'auth') {
    handleAuth(db, jwtSecret, ws, msg);
    return;
  }

  ws.send(JSON.stringify({ event: 'error', code: 'UNKNOWN_EVENT' }));
}

function handleAuth(db, jwtSecret, ws, msg) {
  try {
    if (msg.action === 'register') {
      const user = registerUser(db, msg.username, msg.password);
      const token = signToken({ id: user.id, username: user.username }, jwtSecret);
      ws.send(JSON.stringify({ event: 'auth:ok', token, username: user.username }));
      ws.userId = user.id;
      ws.username = user.username;
      return;
    }

    if (msg.action === 'login') {
      const user = loginUser(db, msg.username, msg.password);
      const token = signToken({ id: user.id, username: user.username }, jwtSecret);
      ws.send(JSON.stringify({ event: 'auth:ok', token, username: user.username }));
      ws.userId = user.id;
      ws.username = user.username;
      return;
    }

    if (msg.action === 'token') {
      const payload = verifyToken(msg.token, jwtSecret);
      ws.send(JSON.stringify({ event: 'auth:ok', username: payload.username }));
      ws.userId = payload.id;
      ws.username = payload.username;
      return;
    }

    ws.send(JSON.stringify({ event: 'auth:error', code: 'UNKNOWN_ACTION' }));
  } catch (err) {
    ws.send(JSON.stringify({ event: 'auth:error', code: err.message }));
  }
}
```

- [ ] **Step 2: Create `packages/server/server.js`**

```js
import 'dotenv/config';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { initDb, closeDb } from './db.js';
import { handleMessage } from './ws-handler.js';

export async function startServer({ port, jwtSecret, dbPath } = {}) {
  const resolvedPort = port ?? Number(process.env.PORT ?? 3000);
  const resolvedSecret = jwtSecret ?? process.env.JWT_SECRET;
  const resolvedDbPath = dbPath ?? process.env.DATABASE_PATH ?? './aux.db';

  if (!resolvedSecret) throw new Error('JWT_SECRET is required');

  const db = initDb(resolvedDbPath);
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => handleMessage(db, resolvedSecret, ws, raw.toString()));
    ws.on('error', (err) => console.error('ws error:', err.message));
  });

  await new Promise((resolve) => httpServer.listen(resolvedPort, resolve));
  console.log(`aux-server listening on :${resolvedPort}`);

  return { httpServer, wss, db };
}

export async function stopServer({ httpServer, wss, db }) {
  wss.close();
  closeDb(db);
  await new Promise((resolve) => httpServer.close(resolve));
}

// Run directly
if (process.argv[1] === new URL(import.meta.url).pathname) {
  startServer().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
```

- [ ] **Step 3: Run all server tests — expect all to pass**

```bash
npm test --workspace=packages/server
```

Expected: All 10 tests PASS (5 unit + 5 WS integration).

- [ ] **Step 4: Commit**

```bash
git add packages/server/ws-handler.js packages/server/server.js packages/server/__tests__/ws-auth.test.js
git commit -m "feat(server): WebSocket server with auth (register/login/token)"
```

---

## Task 6: Daemon — package.json + dependencies

**Files:**
- Create: `packages/daemon/package.json`

- [ ] **Step 1: Create `packages/daemon/package.json`**

```json
{
  "name": "@aux/daemon",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "auxd": "./bin/auxd.js"
  },
  "scripts": {
    "start": "node bin/auxd.js",
    "test": "node --test __tests__/**/*.test.js"
  },
  "dependencies": {
    "ws": "^8.18.0"
  }
}
```

- [ ] **Step 2: Install daemon dependencies**

```bash
npm install --workspace=packages/daemon
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/package.json
git commit -m "feat(daemon): add package.json"
```

---

## Task 7: Daemon — credential storage

**Files:**
- Create: `packages/daemon/__tests__/credentials.test.js`
- Create: `packages/daemon/credentials.js`

- [ ] **Step 1: Write the failing test**

Create `packages/daemon/__tests__/credentials.test.js`:

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveCredentials, loadCredentials, clearCredentials } from '../credentials.js';

const testDir = join(tmpdir(), 'aux-test-' + Date.now());

before(() => mkdirSync(testDir, { recursive: true }));
after(() => rmSync(testDir, { recursive: true }));

test('saveCredentials writes token and username to file', () => {
  saveCredentials({ token: 'tok123', username: 'alice', dir: testDir });
  const creds = loadCredentials({ dir: testDir });
  assert.equal(creds.token, 'tok123');
  assert.equal(creds.username, 'alice');
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

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/daemon
```

Expected: FAIL — `Cannot find module '../credentials.js'`

- [ ] **Step 3: Create `packages/daemon/credentials.js`**

```js
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_DIR = join(homedir(), '.aux');

function credPath(dir) {
  return join(dir ?? DEFAULT_DIR, 'credentials.json');
}

export function saveCredentials({ token, username, dir } = {}) {
  const dirPath = dir ?? DEFAULT_DIR;
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(credPath(dirPath), JSON.stringify({ token, username }), 'utf8');
}

export function loadCredentials({ dir } = {}) {
  const path = credPath(dir ?? DEFAULT_DIR);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function clearCredentials({ dir } = {}) {
  const path = credPath(dir ?? DEFAULT_DIR);
  if (existsSync(path)) rmSync(path);
}
```

- [ ] **Step 4: Run tests — expect all to pass**

```bash
npm test --workspace=packages/daemon
```

Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/__tests__/credentials.test.js packages/daemon/credentials.js
git commit -m "feat(daemon): credential storage (save/load/clear)"
```

---

## Task 8: Daemon — WebSocket client + IPC server

**Files:**
- Create: `packages/daemon/ws-client.js`
- Create: `packages/daemon/ipc-server.js`
- Create: `packages/daemon/bin/auxd.js`

- [ ] **Step 1: Create `packages/daemon/ws-client.js`**

This module manages the persistent WebSocket connection to `aux-server`. It auto-reconnects on disconnect.

```js
import { WebSocket } from 'ws';

const RECONNECT_DELAY_MS = 3000;

export function createWsClient({ serverUrl, onMessage, onConnected }) {
  let ws = null;
  let stopped = false;

  function connect() {
    ws = new WebSocket(serverUrl);

    ws.on('open', () => {
      console.log('[daemon] connected to server');
      onConnected?.(ws);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        onMessage?.(msg, ws);
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
    send(data) { ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(data)); },
    stop() { stopped = true; ws?.close(); }
  };
}
```

- [ ] **Step 2: Create `packages/daemon/ipc-server.js`**

Unix socket server for TUI clients to attach.

```js
import { createServer } from 'node:net';
import { rmSync, existsSync } from 'node:fs';

export const IPC_PATH = '/tmp/aux.sock';

export function createIpcServer({ onConnection }) {
  if (existsSync(IPC_PATH)) rmSync(IPC_PATH);

  const server = createServer((socket) => {
    console.log('[daemon] TUI client connected');
    onConnection?.(socket);

    socket.on('data', (raw) => {
      for (const line of raw.toString().split('\n').filter(Boolean)) {
        try {
          const msg = JSON.parse(line);
          socket.emit('message', msg);
        } catch {
          // ignore malformed
        }
      }
    });

    socket.on('end', () => console.log('[daemon] TUI client disconnected'));
    socket.on('error', (err) => console.error('[daemon] IPC error:', err.message));
  });

  server.listen(IPC_PATH, () => console.log(`[daemon] IPC socket listening at ${IPC_PATH}`));
  return server;
}
```

- [ ] **Step 3: Create `packages/daemon/bin/auxd.js`**

```js
#!/usr/bin/env node
import { writeFileSync, rmSync } from 'node:fs';
import { loadCredentials } from '../credentials.js';
import { createWsClient } from '../ws-client.js';
import { createIpcServer } from '../ipc-server.js';

const PID_FILE = '/tmp/aux.pid';
const SERVER_URL = process.env.AUX_SERVER_URL ?? 'ws://localhost:3000';

// Track connected TUI clients
const tuiClients = new Set();

writeFileSync(PID_FILE, String(process.pid));

process.on('exit', () => rmSync(PID_FILE, { force: true }));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// IPC: broadcast server messages to all connected TUI clients
function broadcast(msg) {
  const line = JSON.stringify(msg) + '\n';
  for (const client of tuiClients) {
    try { client.write(line); } catch { /* client gone */ }
  }
}

const ipc = createIpcServer({
  onConnection(socket) {
    tuiClients.add(socket);
    socket.on('end', () => tuiClients.delete(socket));
    socket.on('error', () => tuiClients.delete(socket));
  }
});

const wsClient = createWsClient({
  serverUrl: SERVER_URL,
  onConnected(ws) {
    // Authenticate with stored credentials if available
    const creds = loadCredentials();
    if (creds?.token) {
      ws.send(JSON.stringify({ event: 'auth', action: 'token', token: creds.token }));
    }
  },
  onMessage(msg) {
    broadcast(msg);
  }
});

console.log(`[auxd] running (pid ${process.pid})`);
```

- [ ] **Step 4: Make the bin executable**

```bash
chmod +x packages/daemon/bin/auxd.js
```

- [ ] **Step 5: Smoke test — start server + daemon together**

In terminal 1:
```bash
cd packages/server && AUX_SERVER_URL=ws://localhost:3000 JWT_SECRET=dev node server.js
```

In terminal 2:
```bash
cd packages/daemon && AUX_SERVER_URL=ws://localhost:3000 node bin/auxd.js
```

Expected: daemon logs `connected to server`, no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/ws-client.js packages/daemon/ipc-server.js packages/daemon/bin/auxd.js
git commit -m "feat(daemon): WebSocket client + IPC server scaffold"
```

---

## Task 9: Client — package.json + aux entry point

**Files:**
- Create: `packages/client/package.json`
- Create: `packages/client/bin/aux.js`

- [ ] **Step 1: Create `packages/client/package.json`**

```json
{
  "name": "@aux/client",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "aux": "./bin/aux.js"
  },
  "scripts": {
    "start": "node bin/aux.js"
  },
  "dependencies": {}
}
```

- [ ] **Step 2: Create `packages/client/bin/aux.js`**

This handles `aux register`, `aux login`, `aux quit` — auth commands that talk to the server directly (no daemon needed). Other commands (join, create, search) will be routed to the daemon in future issues.

```js
#!/usr/bin/env node
import { createConnection } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { saveCredentials, loadCredentials } from '../../daemon/credentials.js';

const IPC_PATH = '/tmp/aux.sock';
const PID_FILE = '/tmp/aux.pid';
const SERVER_URL = process.env.AUX_SERVER_URL ?? 'ws://localhost:3000';

const [,, command, ...args] = process.argv;

async function main() {
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

  console.log('Unknown command. Available: register, login, quit');
}

async function authCommand(action, username, password) {
  const { WebSocket } = await import('ws');
  const ws = new WebSocket(SERVER_URL);

  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ event: 'auth', action, username, password }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.event === 'auth:ok') {
        saveCredentials({ token: msg.token, username: msg.username });
        console.log(`Logged in as ${msg.username}`);
        ws.close();
        resolve();
      } else if (msg.event === 'auth:error') {
        console.error(`Error: ${msg.code}`);
        ws.close();
        reject(new Error(msg.code));
      }
    });

    ws.on('error', reject);
  });
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 3: Install client dependencies**

```bash
npm install --workspace=packages/client
```

- [ ] **Step 4: Make the bin executable**

```bash
chmod +x packages/client/bin/aux.js
```

- [ ] **Step 5: End-to-end smoke test**

Start server:
```bash
cd packages/server && JWT_SECRET=dev node server.js
```

Register and login:
```bash
node packages/client/bin/aux.js register testuser testpass
# Expected: Logged in as testuser

node packages/client/bin/aux.js login testuser testpass
# Expected: Logged in as testuser
```

Check that `~/.aux/credentials.json` was created:
```bash
cat ~/.aux/credentials.json
# Expected: {"token":"<jwt>","username":"testuser"}
```

- [ ] **Step 6: Commit**

```bash
git add packages/client/package.json packages/client/bin/aux.js
git commit -m "feat(client): aux CLI entry point with register/login/quit"
```

---

## Task 10: Final integration + README update

- [ ] **Step 1: Run all tests across all workspaces**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 2: Add `.env.example` note to CLAUDE.md** (if missing)

Verify `CLAUDE.md` already documents environment variables — it does, no change needed.

- [ ] **Step 3: Update `.gitignore` to exclude `*.db` files**

```bash
echo "*.db" >> .gitignore
```

- [ ] **Step 4: Final commit**

```bash
git add .gitignore
git commit -m "chore: ignore SQLite db files"
```

---

## Self-Review

**Spec coverage:**
- ✅ Server starts and accepts WebSocket connections
- ✅ Register with username + password (bcrypt hashed)
- ✅ Login with username + password → JWT
- ✅ Reconnect with JWT token (`auth:token` action)
- ✅ Daemon connects to server and authenticates on reconnect
- ✅ Daemon exposes Unix socket for TUI (IPC)
- ✅ `aux register` / `aux login` CLI commands
- ✅ `aux quit` stops the daemon via PID file
- ✅ Credentials persisted to `~/.aux/credentials.json`
- ✅ Tests: unit (auth logic) + integration (WS auth flow) + unit (credentials)

**Placeholder scan:** None found. All steps include actual code.

**Type consistency:**
- `registerUser(db, username, password)` → used consistently in auth.js + ws-handler.js + tests ✅
- `signToken(payload, secret)` / `verifyToken(token, secret)` → consistent ✅
- `startServer({ port, jwtSecret, dbPath })` / `stopServer({ httpServer, wss, db })` → consistent ✅
- `saveCredentials({ token, username, dir })` / `loadCredentials({ dir })` → consistent ✅
- `createWsClient({ serverUrl, onMessage, onConnected })` → consistent ✅
- `createIpcServer({ onConnection })` → consistent ✅
