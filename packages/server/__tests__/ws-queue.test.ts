import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer, stopServer, type ServerHandle } from '../src/server.js';
import { registerUser } from '../src/auth.js';

const PORT = 13002;
const JWT_SECRET = 'test-secret-queue';

let server: ServerHandle;

function wsConnect(port: number): WebSocket {
  return new WebSocket(`ws://localhost:${port}`);
}

interface MsgQueue {
  next(): Promise<Record<string, unknown>>;
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
    ws.once('close', () => resolve());
    ws.close();
  });
}

async function openAndAuth(port: number, username: string, password: string): Promise<{ ws: WebSocket; q: MsgQueue }> {
  const ws = wsConnect(port);
  const q = makeQueue(ws);
  await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(JSON.stringify({ event: 'auth', action: 'login', username, password }));
  const authMsg = await q.next();
  assert.equal(authMsg['event'], 'auth:ok');
  return { ws, q };
}

before(async () => {
  server = await startServer({ port: PORT, jwtSecret: JWT_SECRET, dbPath: ':memory:' });
  registerUser(server.db, 'alice', 'pass123');
  registerUser(server.db, 'bob', 'pass456');
});

after(async () => {
  await stopServer(server);
});

test('queue:add appends track and broadcasts queue:update', async () => {
  const { ws: alice, q } = await openAndAuth(PORT, 'alice', 'pass123');
  try {
    alice.send(JSON.stringify({ event: 'room:create', name: 'qtest1' }));
    const syncMsg = await q.next();
    assert.equal(syncMsg['event'], 'state:sync');

    alice.send(JSON.stringify({
      event: 'queue:add',
      youtubeUrl: 'https://youtube.com/watch?v=abc',
      title: 'Harder Better Faster',
      artist: 'Daft Punk',
      duration: 224,
    }));

    const msg = await q.next();
    assert.equal(msg['event'], 'queue:update');
    const queue = msg['queue'] as Array<Record<string, unknown>>;
    assert.equal(queue.length, 1);
    assert.equal(queue[0]!['title'], 'Harder Better Faster');
    assert.equal(queue[0]!['artist'], 'Daft Punk');
    assert.equal(queue[0]!['duration'], 224);
  } finally {
    await closeWs(alice);
  }
});

test('queue:add broadcasts to all room members', async () => {
  const { ws: alice, q: aliceQ } = await openAndAuth(PORT, 'alice', 'pass123');
  const { ws: bob, q: bobQ } = await openAndAuth(PORT, 'bob', 'pass456');
  try {
    alice.send(JSON.stringify({ event: 'room:create', name: 'qtest2' }));
    await aliceQ.next(); // alice state:sync

    bob.send(JSON.stringify({ event: 'room:join', name: 'qtest2' }));
    await Promise.all([aliceQ.next(), bobQ.next()]); // both get state:sync

    alice.send(JSON.stringify({
      event: 'queue:add',
      youtubeUrl: 'https://youtube.com/watch?v=xyz',
      title: 'Get Lucky',
      artist: 'Daft Punk',
      duration: 248,
    }));

    const [aliceMsg, bobMsg] = await Promise.all([aliceQ.next(), bobQ.next()]);
    assert.equal(aliceMsg['event'], 'queue:update');
    assert.equal(bobMsg['event'], 'queue:update');
    const aliceQueue = aliceMsg['queue'] as Array<Record<string, unknown>>;
    const bobQueue = bobMsg['queue'] as Array<Record<string, unknown>>;
    assert.equal(aliceQueue[0]!['title'], 'Get Lucky');
    assert.equal(bobQueue[0]!['title'], 'Get Lucky');
  } finally {
    await Promise.all([closeWs(alice), closeWs(bob)]);
  }
});

test('queue:add returns queue:error NOT_IN_ROOM if not in room', async () => {
  const { ws, q } = await openAndAuth(PORT, 'alice', 'pass123');
  try {
    ws.send(JSON.stringify({
      event: 'queue:add',
      youtubeUrl: 'https://youtube.com/watch?v=abc',
      title: 'A',
      artist: 'X',
      duration: 100,
    }));

    const msg = await q.next();
    assert.equal(msg['event'], 'queue:error');
    assert.equal(msg['code'], 'NOT_IN_ROOM');
  } finally {
    await closeWs(ws);
  }
});

test('queue:add returns queue:error MISSING_FIELDS for invalid payload', async () => {
  const { ws: alice, q } = await openAndAuth(PORT, 'alice', 'pass123');
  try {
    alice.send(JSON.stringify({ event: 'room:create', name: 'qtest3' }));
    await q.next(); // state:sync

    alice.send(JSON.stringify({ event: 'queue:add', youtubeUrl: '', title: 'A', artist: 'X', duration: 100 }));
    const msg = await q.next();
    assert.equal(msg['event'], 'queue:error');
    assert.equal(msg['code'], 'MISSING_FIELDS');
  } finally {
    await closeWs(alice);
  }
});

test('queue accumulates multiple tracks in order', async () => {
  const { ws: alice, q } = await openAndAuth(PORT, 'alice', 'pass123');
  try {
    alice.send(JSON.stringify({ event: 'room:create', name: 'qtest4' }));
    await q.next(); // state:sync

    const tracks = [
      { youtubeUrl: 'https://youtube.com/watch?v=1', title: 'Track One', artist: 'A', duration: 100 },
      { youtubeUrl: 'https://youtube.com/watch?v=2', title: 'Track Two', artist: 'B', duration: 200 },
      { youtubeUrl: 'https://youtube.com/watch?v=3', title: 'Track Three', artist: 'C', duration: 300 },
    ];

    // First track triggers both queue:update and playback:next
    alice.send(JSON.stringify({ event: 'queue:add', ...tracks[0] }));
    await q.next(); // queue:update
    await q.next(); // playback:next (first track starts playback)

    // Remaining tracks only trigger queue:update (playback already running)
    for (const t of tracks.slice(1)) {
      alice.send(JSON.stringify({ event: 'queue:add', ...t }));
      await q.next(); // queue:update
    }

    alice.send(JSON.stringify({ event: 'queue:add', youtubeUrl: 'https://youtube.com/watch?v=4', title: 'Track Four', artist: 'D', duration: 400 }));
    const last = await q.next();
    const queue = last['queue'] as Array<Record<string, unknown>>;
    // Track One is nowPlaying (shifted from queue), so queue contains tracks 2-4
    assert.equal(queue.length, 3);
    assert.equal(queue[0]!['title'], 'Track Two');
    assert.equal(queue[2]!['title'], 'Track Four');
  } finally {
    await closeWs(alice);
  }
});
