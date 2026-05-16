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

test('room:leave — remaining member receives updated state:sync', async () => {
  const wsAlice = openWs();
  const wsBob = openWs();
  try {
    await authenticate(wsAlice, 'alice', 'pass');
    send(wsAlice, { event: 'room:create', name: 'leaveroom' });
    await waitMsg(wsAlice); // state:sync

    await authenticate(wsBob, 'bob', 'pass');
    const aliceJoinP = waitMsg(wsAlice);
    const bobJoinP = waitMsg(wsBob);
    send(wsBob, { event: 'room:join', name: 'leaveroom' });
    await Promise.all([aliceJoinP, bobJoinP]); // both receive state:sync

    // Bob leaves; Alice should receive an updated state:sync with only herself
    const aliceUpdateP = waitMsg(wsAlice);
    send(wsBob, { event: 'room:leave' });
    await waitMsg(wsBob); // room:left confirmation
    const aliceUpdate = await aliceUpdateP;
    assert.equal(aliceUpdate['event'], 'state:sync');
    const room = aliceUpdate['room'] as Record<string, unknown>;
    const members = room['members'] as Array<{ username: string }>;
    assert.equal(members.length, 1);
    assert.equal(members[0]!.username, 'alice');
  } finally {
    wsAlice.close();
    wsBob.close();
    await Promise.all([
      new Promise((r) => wsAlice.once('close', r)),
      new Promise((r) => wsBob.once('close', r)),
    ]);
  }
});

test('room:leave — host leaves, next member becomes host', async () => {
  const wsAlice = openWs();
  const wsBob = openWs();
  try {
    await authenticate(wsAlice, 'alice', 'pass');
    send(wsAlice, { event: 'room:create', name: 'hosttransfer' });
    const aliceSync1 = await waitMsg(wsAlice);
    const aliceRoom1 = aliceSync1['room'] as Record<string, unknown>;
    const hostId = aliceRoom1['hostId'] as string;

    await authenticate(wsBob, 'bob', 'pass');
    const aliceJoinP = waitMsg(wsAlice);
    const bobJoinP = waitMsg(wsBob);
    send(wsBob, { event: 'room:join', name: 'hosttransfer' });
    await Promise.all([aliceJoinP, bobJoinP]);

    // Alice (host) leaves; Bob should receive state:sync where he is the new host
    const bobUpdateP = waitMsg(wsBob);
    send(wsAlice, { event: 'room:leave' });
    await waitMsg(wsAlice); // room:left
    const bobUpdate = await bobUpdateP;
    assert.equal(bobUpdate['event'], 'state:sync');
    const room = bobUpdate['room'] as Record<string, unknown>;
    assert.notEqual(room['hostId'], hostId);
    const members = room['members'] as Array<{ id: string }>;
    assert.equal(members.length, 1);
    assert.equal(room['hostId'], members[0]!.id);
  } finally {
    wsAlice.close();
    wsBob.close();
    await Promise.all([
      new Promise((r) => wsAlice.once('close', r)),
      new Promise((r) => wsBob.once('close', r)),
    ]);
  }
});

test('room:leave — last member leaves, room is deleted without error', async () => {
  const ws = openWs();
  try {
    await authenticate(ws, 'alice', 'pass');
    send(ws, { event: 'room:create', name: 'soloroom' });
    await waitMsg(ws); // state:sync

    send(ws, { event: 'room:leave' });
    const msg = await waitMsg(ws);
    assert.equal(msg['event'], 'room:left');

    // Verify room is gone — join attempt should return ROOM_NOT_FOUND
    send(ws, { event: 'room:join', name: 'soloroom' });
    const notFound = await waitMsg(ws);
    assert.equal(notFound['event'], 'room:error');
    assert.equal(notFound['code'], 'ROOM_NOT_FOUND');
  } finally {
    ws.close();
    await new Promise((r) => ws.once('close', r));
  }
});

test('disconnect without room:leave — member is cleaned up from room', async () => {
  const wsAlice = openWs();
  const wsBob = openWs();
  try {
    await authenticate(wsAlice, 'alice', 'pass');
    send(wsAlice, { event: 'room:create', name: 'cleanuproom' });
    await waitMsg(wsAlice); // state:sync

    await authenticate(wsBob, 'bob', 'pass');
    const aliceJoinP = waitMsg(wsAlice);
    const bobJoinP = waitMsg(wsBob);
    send(wsBob, { event: 'room:join', name: 'cleanuproom' });
    await Promise.all([aliceJoinP, bobJoinP]);

    // Bob disconnects abruptly — Alice should receive state:sync with only herself
    const aliceUpdateP = waitMsg(wsAlice);
    wsBob.close();
    await new Promise((r) => wsBob.once('close', r));
    const aliceUpdate = await aliceUpdateP;
    assert.equal(aliceUpdate['event'], 'state:sync');
    const room = aliceUpdate['room'] as Record<string, unknown>;
    const members = room['members'] as Array<{ username: string }>;
    assert.equal(members.length, 1);
    assert.equal(members[0]!.username, 'alice');
  } finally {
    wsAlice.close();
    await new Promise((r) => wsAlice.once('close', r));
  }
});
