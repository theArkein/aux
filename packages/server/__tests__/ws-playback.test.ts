import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer, stopServer, type ServerHandle } from '../src/server.js';
import { registerUser } from '../src/auth.js';

const PORT = 13003;
const JWT_SECRET = 'test-secret-playback';

let server: ServerHandle;

function wsConnect(): WebSocket {
  return new WebSocket(`ws://localhost:${PORT}`);
}

function nextMsg(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once('message', (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
    ws.once('error', reject);
  });
}

function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    ws.once('close', resolve);
    ws.close();
  });
}

async function authAndCreate(username: string, password: string, roomName: string): Promise<WebSocket> {
  const ws = wsConnect();
  await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(JSON.stringify({ event: 'auth', action: 'login', username, password }));
  await nextMsg(ws); // auth:ok
  ws.send(JSON.stringify({ event: 'room:create', name: roomName }));
  await nextMsg(ws); // state:sync
  return ws;
}

before(async () => {
  server = await startServer({ port: PORT, jwtSecret: JWT_SECRET, dbPath: ':memory:' });
  registerUser(server.db, 'alice', 'pass123');
});

after(async () => {
  await stopServer(server);
});

test('queue:add emits playback:next when nothing playing', async () => {
  const alice = await authAndCreate('alice', 'pass123', 'pbtest1');

  alice.send(JSON.stringify({
    event: 'queue:add',
    youtubeUrl: 'https://youtube.com/watch?v=abc',
    title: 'Track One',
    artist: 'Artist',
    duration: 180,
  }));

  const queueUpdate = await nextMsg(alice); // queue:update
  assert.equal(queueUpdate['event'], 'queue:update');

  const pbNext = await nextMsg(alice); // playback:next
  assert.equal(pbNext['event'], 'playback:next');
  const track = pbNext['track'] as Record<string, unknown>;
  assert.equal(track['title'], 'Track One');
  assert.ok(typeof pbNext['startAt'] === 'number');
  assert.ok((pbNext['startAt'] as number) > Date.now());

  await closeWs(alice);
});

test('queue:add does not emit playback:next if already playing', async () => {
  const alice = await authAndCreate('alice', 'pass123', 'pbtest2');

  // First track starts playback
  alice.send(JSON.stringify({
    event: 'queue:add',
    youtubeUrl: 'https://youtube.com/watch?v=first',
    title: 'First', artist: 'A', duration: 100,
  }));
  await nextMsg(alice); // queue:update
  await nextMsg(alice); // playback:next

  // Second track goes into queue without triggering playback:next
  alice.send(JSON.stringify({
    event: 'queue:add',
    youtubeUrl: 'https://youtube.com/watch?v=second',
    title: 'Second', artist: 'A', duration: 100,
  }));
  const qUpdate = await nextMsg(alice); // queue:update
  assert.equal(qUpdate['event'], 'queue:update');

  // No more messages expected — set a 200ms timeout
  let gotExtra = false;
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 200);
    alice.once('message', () => { gotExtra = true; clearTimeout(t); resolve(); });
  });
  assert.equal(gotExtra, false, 'should not emit second playback:next while already playing');

  await closeWs(alice);
});

test('playback:ended with next track emits playback:next', async () => {
  const alice = await authAndCreate('alice', 'pass123', 'pbtest3');

  // Queue two tracks
  alice.send(JSON.stringify({ event: 'queue:add', youtubeUrl: 'https://youtube.com/watch?v=a', title: 'T1', artist: 'A', duration: 100 }));
  await nextMsg(alice); // queue:update
  await nextMsg(alice); // playback:next (T1)

  alice.send(JSON.stringify({ event: 'queue:add', youtubeUrl: 'https://youtube.com/watch?v=b', title: 'T2', artist: 'A', duration: 200 }));
  await nextMsg(alice); // queue:update (T2 queued, not playing)

  // Signal track ended
  alice.send(JSON.stringify({ event: 'playback:ended' }));

  const stateSync = await nextMsg(alice); // state:sync
  assert.equal(stateSync['event'], 'state:sync');

  const pbNext = await nextMsg(alice); // playback:next for T2
  assert.equal(pbNext['event'], 'playback:next');
  const track = pbNext['track'] as Record<string, unknown>;
  assert.equal(track['title'], 'T2');

  await closeWs(alice);
});

test('playback:ended with empty queue emits state:sync without playback:next', async () => {
  const alice = await authAndCreate('alice', 'pass123', 'pbtest4');

  alice.send(JSON.stringify({ event: 'queue:add', youtubeUrl: 'https://youtube.com/watch?v=a', title: 'Only', artist: 'A', duration: 100 }));
  await nextMsg(alice); // queue:update
  await nextMsg(alice); // playback:next

  alice.send(JSON.stringify({ event: 'playback:ended' }));
  const stateSync = await nextMsg(alice);
  assert.equal(stateSync['event'], 'state:sync');
  const room = stateSync['room'] as Record<string, unknown>;
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
