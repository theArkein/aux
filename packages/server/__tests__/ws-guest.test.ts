import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer, stopServer, type ServerHandle } from '../src/server.js';
import { registerUser } from '../src/auth.js';

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

before(async () => {
  server = await startServer({ port: PORT, jwtSecret: JWT_SECRET, dbPath: ':memory:' });
  registerUser(server.db, 'alice', 'passw');
});

after(async () => {
  await stopServer(server);
});

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
