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
