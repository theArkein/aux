import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Room } from '../src/types.js';
import { addTrack } from '../src/queue.js';

function makeRoom(): Room {
  return {
    id: 'r1',
    name: 'lounge',
    hostId: 'u1',
    members: [{ id: 'u1', username: 'alice' }],
    queue: [],
    createdAt: Date.now(),
  };
}

test('addTrack appends track and returns it', () => {
  const room = makeRoom();
  const track = addTrack(room, {
    youtubeUrl: 'https://youtube.com/watch?v=abc',
    title: 'Harder Better Faster',
    artist: 'Daft Punk',
    duration: 224,
    queuedBy: 'u1',
  });
  assert.equal(room.queue.length, 1);
  assert.equal(track.title, 'Harder Better Faster');
  assert.ok(track.id, 'track has id');
});

test('addTrack assigns unique ids', () => {
  const room = makeRoom();
  const t1 = addTrack(room, { youtubeUrl: 'https://youtube.com/watch?v=a', title: 'A', artist: 'X', duration: 100, queuedBy: 'u1' });
  const t2 = addTrack(room, { youtubeUrl: 'https://youtube.com/watch?v=b', title: 'B', artist: 'X', duration: 200, queuedBy: 'u1' });
  assert.notEqual(t1.id, t2.id);
  assert.equal(room.queue.length, 2);
});

test('addTrack throws MISSING_FIELDS if youtubeUrl empty', () => {
  const room = makeRoom();
  assert.throws(
    () => addTrack(room, { youtubeUrl: '', title: 'A', artist: 'X', duration: 100, queuedBy: 'u1' }),
    /MISSING_FIELDS/
  );
});

test('addTrack throws MISSING_FIELDS if title empty', () => {
  const room = makeRoom();
  assert.throws(
    () => addTrack(room, { youtubeUrl: 'https://youtube.com/watch?v=a', title: '', artist: 'X', duration: 100, queuedBy: 'u1' }),
    /MISSING_FIELDS/
  );
});
