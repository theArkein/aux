import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Room, Track } from '../src/types.js';
import { startPlayback, endPlayback } from '../src/playback.js';

function makeTrack(id: string): Track {
  return { id, youtubeUrl: `https://youtube.com/watch?v=${id}`, title: `Track ${id}`, artist: 'Artist', duration: 180, queuedBy: 'u1' };
}

function makeRoom(queue: Track[] = []): Room {
  return {
    id: 'r1', name: 'lounge', hostId: 'u1',
    members: [{ id: 'u1', username: 'alice' }],
    queue,
    nowPlaying: null,
    playbackStartedAt: null,
    createdAt: Date.now(),
  };
}

test('startPlayback returns null when queue is empty', () => {
  const room = makeRoom([]);
  const result = startPlayback(room);
  assert.equal(result, null);
  assert.equal(room.nowPlaying, null);
});

test('startPlayback dequeues first track and sets nowPlaying', () => {
  const t1 = makeTrack('a');
  const t2 = makeTrack('b');
  const room = makeRoom([t1, t2]);
  const result = startPlayback(room);
  assert.equal(result?.id, 'a');
  assert.equal(room.nowPlaying?.id, 'a');
  assert.equal(room.queue.length, 1);
  assert.equal(room.queue[0]!.id, 'b');
  assert.ok(room.playbackStartedAt !== null);
});

test('startPlayback returns null and does not change state if already playing', () => {
  const t1 = makeTrack('a');
  const room = makeRoom([t1]);
  room.nowPlaying = makeTrack('x');
  room.playbackStartedAt = Date.now();
  const result = startPlayback(room);
  assert.equal(result, null);
  assert.equal(room.nowPlaying?.id, 'x');
  assert.equal(room.queue.length, 1);
});

test('endPlayback clears nowPlaying and returns next track when queue has items', () => {
  const t2 = makeTrack('b');
  const room = makeRoom([t2]);
  room.nowPlaying = makeTrack('a');
  room.playbackStartedAt = Date.now();
  const next = endPlayback(room);
  assert.equal(next?.id, 'b');
  assert.equal(room.nowPlaying?.id, 'b');
  assert.equal(room.queue.length, 0);
});

test('endPlayback clears nowPlaying and returns null when queue empty', () => {
  const room = makeRoom([]);
  room.nowPlaying = makeTrack('a');
  room.playbackStartedAt = Date.now();
  const next = endPlayback(room);
  assert.equal(next, null);
  assert.equal(room.nowPlaying, null);
  assert.equal(room.playbackStartedAt, null);
});
