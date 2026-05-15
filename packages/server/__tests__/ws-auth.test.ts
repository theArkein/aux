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
