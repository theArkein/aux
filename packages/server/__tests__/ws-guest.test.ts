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
