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
  if (ws.readyState !== WebSocket.OPEN) {
    await new Promise<void>((resolve) => ws.once('open', resolve));
  }
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

    // register listeners for both clients BEFORE sending join to avoid race
    const aliceSyncP = waitMsg(wsAlice);
    const bobSyncP = waitMsg(wsBob);
    send(wsBob, { event: 'room:join', name: 'sharedroom' });
    const [bobSync, aliceSync2] = await Promise.all([bobSyncP, aliceSyncP]);

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
