import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer, stopServer, type ServerHandle } from '../src/server.js';
import { registerUser } from '../src/auth.js';

const PORT = 13004;
const JWT_SECRET = 'test-secret-skip';

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

async function openAndAuth(username: string, password: string): Promise<{ ws: WebSocket; q: MsgQueue }> {
  const ws = wsConnect();
  const q = makeQueue(ws);
  await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(JSON.stringify({ event: 'auth', action: 'login', username, password }));
  const auth = await q.next();
  assert.equal(auth['event'], 'auth:ok');
  return { ws, q };
}

async function addTrackAndStart(ws: WebSocket, q: MsgQueue): Promise<Record<string, unknown>> {
  ws.send(JSON.stringify({ event: 'queue:add', youtubeUrl: 'https://youtube.com/watch?v=abc', title: 'Song', artist: 'Artist', duration: 180 }));
  await q.next(); // queue:update
  return q.next(); // playback:next
}

before(async () => {
  server = await startServer({ port: PORT, jwtSecret: JWT_SECRET, dbPath: ':memory:' });
  registerUser(server.db, 'alice', 'pass123');
  registerUser(server.db, 'bob', 'pass456');
  registerUser(server.db, 'carol', 'pass789');
});

after(async () => {
  await stopServer(server);
});

test('host skip immediately advances track', async () => {
  const { ws: alice, q: qa } = await openAndAuth('alice', 'pass123');

  alice.send(JSON.stringify({ event: 'room:create', name: 'skiptest1' }));
  await qa.next(); // state:sync

  // Queue two tracks
  await addTrackAndStart(alice, qa);
  alice.send(JSON.stringify({ event: 'queue:add', youtubeUrl: 'https://youtube.com/watch?v=second', title: 'Second', artist: 'A', duration: 120 }));
  await qa.next(); // queue:update for second track

  // Host skips
  alice.send(JSON.stringify({ event: 'queue:skip' }));
  const sync = await qa.next();
  assert.equal(sync['event'], 'state:sync');
  const pbNext = await qa.next();
  assert.equal(pbNext['event'], 'playback:next');
  const track = pbNext['track'] as Record<string, unknown>;
  assert.equal(track['title'], 'Second');

  await closeWs(alice);
});

test('host skip with empty queue clears nowPlaying', async () => {
  const { ws: alice, q: qa } = await openAndAuth('alice', 'pass123');

  alice.send(JSON.stringify({ event: 'room:create', name: 'skiptest2' }));
  await qa.next(); // state:sync

  await addTrackAndStart(alice, qa);

  alice.send(JSON.stringify({ event: 'queue:skip' }));
  const sync = await qa.next();
  assert.equal(sync['event'], 'state:sync');
  const room = sync['room'] as Record<string, unknown>;
  assert.equal(room['nowPlaying'], null);

  // No playback:next expected
  let gotExtra = false;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 200);
    alice.once('message', () => { gotExtra = true; clearTimeout(t); resolve(); });
  });
  assert.equal(gotExtra, false);

  await closeWs(alice);
});

test('non-host vote is registered and shown in state:sync', async () => {
  const { ws: alice, q: qa } = await openAndAuth('alice', 'pass123');
  const { ws: bob, q: qb } = await openAndAuth('bob', 'pass456');

  alice.send(JSON.stringify({ event: 'room:create', name: 'skiptest3' }));
  await qa.next(); // state:sync alice

  bob.send(JSON.stringify({ event: 'room:join', name: 'skiptest3' }));
  await qa.next(); // state:sync broadcast to alice (bob joined)
  await qb.next(); // state:sync to bob

  alice.send(JSON.stringify({ event: 'queue:add', youtubeUrl: 'https://youtube.com/watch?v=x', title: 'T1', artist: 'A', duration: 100 }));
  await qa.next(); await qa.next(); // queue:update + playback:next (alice)
  await qb.next(); await qb.next(); // queue:update + playback:next (bob)

  // Bob votes to skip (not host — alice is host)
  bob.send(JSON.stringify({ event: 'queue:skip' }));

  // Both get state:sync with skipVotes updated
  const syncForAlice = await qa.next();
  assert.equal(syncForAlice['event'], 'state:sync');
  const roomA = syncForAlice['room'] as Record<string, unknown>;
  const votes = roomA['skipVotes'] as string[];
  assert.equal(votes.length, 1); // bob's vote

  const syncForBob = await qb.next();
  assert.equal(syncForBob['event'], 'state:sync');
  const roomB = syncForBob['room'] as Record<string, unknown>;
  assert.equal((roomB['skipVotes'] as string[]).length, 1);

  await closeWs(alice);
  await closeWs(bob);
});

test('majority vote (>50%) triggers skip', async () => {
  const { ws: alice, q: qa } = await openAndAuth('alice', 'pass123');
  const { ws: bob, q: qb } = await openAndAuth('bob', 'pass456');
  const { ws: carol, q: qc } = await openAndAuth('carol', 'pass789');

  alice.send(JSON.stringify({ event: 'room:create', name: 'skiptest4' }));
  await qa.next(); // state:sync

  bob.send(JSON.stringify({ event: 'room:join', name: 'skiptest4' }));
  await qa.next(); await qb.next(); // state:sync both

  carol.send(JSON.stringify({ event: 'room:join', name: 'skiptest4' }));
  await qa.next(); await qb.next(); await qc.next(); // state:sync all

  // Queue two tracks — all 3 clients get queue:update + playback:next
  alice.send(JSON.stringify({ event: 'queue:add', youtubeUrl: 'https://youtube.com/watch?v=first', title: 'First', artist: 'A', duration: 100 }));
  await qa.next(); await qa.next();
  await qb.next(); await qb.next();
  await qc.next(); await qc.next();

  alice.send(JSON.stringify({ event: 'queue:add', youtubeUrl: 'https://youtube.com/watch?v=second', title: 'Second', artist: 'A', duration: 100 }));
  await qa.next(); await qb.next(); await qc.next(); // queue:update

  // Bob votes (1/3 — not majority)
  bob.send(JSON.stringify({ event: 'queue:skip' }));
  const s1a = await qa.next(); // state:sync
  assert.equal(s1a['event'], 'state:sync');
  assert.equal(((s1a['room'] as Record<string, unknown>)['skipVotes'] as string[]).length, 1);
  await qb.next(); await qc.next(); // state:sync for bob and carol

  // Carol votes (2/3 — majority >1.5 → triggered)
  carol.send(JSON.stringify({ event: 'queue:skip' }));

  const s2a = await qa.next();
  assert.equal(s2a['event'], 'state:sync');
  const roomAfter = s2a['room'] as Record<string, unknown>;
  assert.deepEqual(roomAfter['skipVotes'], []); // votes cleared

  const pb = await qa.next();
  assert.equal(pb['event'], 'playback:next');
  assert.equal(((pb['track'] as Record<string, unknown>)['title']), 'Second');

  await closeWs(alice);
  await closeWs(bob);
  await closeWs(carol);
});

test('queue:skip when nothing playing returns error', async () => {
  const { ws: alice, q: qa } = await openAndAuth('alice', 'pass123');

  alice.send(JSON.stringify({ event: 'room:create', name: 'skiptest5' }));
  await qa.next(); // state:sync (nothing playing)

  alice.send(JSON.stringify({ event: 'queue:skip' }));
  const err = await qa.next();
  assert.equal(err['event'], 'queue:error');
  assert.equal(err['code'], 'NOTHING_PLAYING');

  await closeWs(alice);
});
