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

test('guest can queue:add a track', async () => {
  const { ws: alice, q: qa } = await openAndAuthUser('alice', 'passw');
  const { ws: guest, q: qg } = await authenticateAsGuest();
  try {
    alice.send(JSON.stringify({ event: 'room:create', name: 'guestq1' }));
    await qa.next(); // alice: state:sync

    const ap = qa.next();
    const gp = qg.next();
    guest.send(JSON.stringify({ event: 'room:join', name: 'guestq1' }));
    await Promise.all([ap, gp]); // both receive state:sync

    // Guest queues a track
    guest.send(JSON.stringify({
      event: 'queue:add',
      youtubeUrl: 'https://youtube.com/watch?v=gst1',
      title: 'GuestTrack',
      artist: 'G',
      duration: 100,
    }));
    const aliceUpdate = await qa.next();
    const guestUpdate = await qg.next();
    assert.equal(aliceUpdate['event'], 'queue:update');
    assert.equal(guestUpdate['event'], 'queue:update');
    const queue = aliceUpdate['queue'] as Array<{ title: string }>;
    assert.equal(queue[0]!.title, 'GuestTrack');
    // drain playback:next so buffer stays clean
    const alicePb = await qa.next();
    const guestPb = await qg.next();
    assert.equal(alicePb['event'], 'playback:next');
    assert.equal(guestPb['event'], 'playback:next');
  } finally {
    await closeWs(alice);
    await closeWs(guest);
  }
});

test('guest vote-skip is registered', async () => {
  const { ws: alice, q: qa } = await openAndAuthUser('alice', 'passw');
  const { ws: guest, q: qg } = await authenticateAsGuest();
  try {
    alice.send(JSON.stringify({ event: 'room:create', name: 'guestvote1' }));
    await qa.next(); // state:sync

    const ap = qa.next();
    const gp = qg.next();
    guest.send(JSON.stringify({ event: 'room:join', name: 'guestvote1' }));
    await Promise.all([ap, gp]);

    // Alice queues → starts playback (both clients receive queue:update + playback:next)
    alice.send(JSON.stringify({
      event: 'queue:add',
      youtubeUrl: 'https://youtube.com/watch?v=vote',
      title: 'VoteTrack',
      artist: 'A',
      duration: 100,
    }));
    await qa.next(); await qa.next(); // queue:update + playback:next for alice
    await qg.next(); await qg.next(); // same for guest

    // Guest votes to skip (guest is not host; alice created the room → alice is host)
    const syncForAliceP = qa.next();
    const syncForGuestP = qg.next();
    guest.send(JSON.stringify({ event: 'queue:skip' }));
    const [syncForAlice, syncForGuest] = await Promise.all([syncForAliceP, syncForGuestP]);

    assert.equal(syncForAlice['event'], 'state:sync');
    const room = syncForAlice['room'] as Record<string, unknown>;
    assert.equal((room['skipVotes'] as string[]).length, 1);
    assert.equal(syncForGuest['event'], 'state:sync');
    const roomG = syncForGuest['room'] as Record<string, unknown>;
    assert.equal((roomG['skipVotes'] as string[]).length, 1);
  } finally {
    await closeWs(alice);
    await closeWs(guest);
  }
});

test('guest disconnect clears them from the room', { timeout: 3000 }, async () => {
  const { ws: alice, q: qa } = await openAndAuthUser('alice', 'passw');
  const { ws: guest, q: qg } = await authenticateAsGuest();
  try {
    alice.send(JSON.stringify({ event: 'room:create', name: 'guestdisco1' }));
    await qa.next(); // state:sync (alice only)

    const ap = qa.next();
    const gp = qg.next();
    guest.send(JSON.stringify({ event: 'room:join', name: 'guestdisco1' }));
    await Promise.all([ap, gp]); // both receive state:sync

    // Guest disconnects — alice should receive state:sync with only herself
    const aliceUpdateP = qa.next();
    await closeWs(guest);
    const aliceUpdate = await aliceUpdateP;

    assert.equal(aliceUpdate['event'], 'state:sync');
    const room = aliceUpdate['room'] as Record<string, unknown>;
    const members = room['members'] as Array<{ username: string }>;
    assert.equal(members.length, 1);
    assert.equal(members[0]!.username, 'alice');
  } finally {
    await closeWs(alice);
  }
});

test('two guests get independent guest_ usernames', async () => {
  const { ws: g1, username: u1 } = await authenticateAsGuest();
  const { ws: g2, username: u2 } = await authenticateAsGuest();
  try {
    assert.match(u1, /^guest_[0-9a-f]{4}$/);
    assert.match(u2, /^guest_[0-9a-f]{4}$/);
    // 1-in-65536 collision chance; asserting inequality catches the common bug where the same ID is reused
    assert.notEqual(u1, u2);
  } finally {
    await closeWs(g1);
    await closeWs(g2);
  }
});
