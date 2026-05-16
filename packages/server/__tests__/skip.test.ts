import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Room, Track } from '../src/types.js';
import { registerVote } from '../src/skip.js';

function makeTrack(id: string): Track {
  return { id, youtubeUrl: `https://youtube.com/watch?v=${id}`, title: `T${id}`, artist: 'A', duration: 180, queuedBy: 'u1' };
}

function makeRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: 'r1',
    name: 'lounge',
    hostId: 'u1',
    members: [
      { id: 'u1', username: 'alice' },
      { id: 'u2', username: 'bob' },
      { id: 'u3', username: 'carol' },
    ],
    queue: [],
    nowPlaying: makeTrack('x'),
    playbackStartedAt: Date.now(),
    skipVotes: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

test('registerVote: first vote below majority — not triggered', () => {
  const room = makeRoom(); // 3 members, need >1.5 = 2 votes
  const result = registerVote(room, 'u2');
  assert.equal(result.triggered, false);
  assert.equal(result.votes, 1);
  assert.equal(result.total, 3);
  assert.deepEqual(room.skipVotes, ['u2']);
});

test('registerVote: majority vote triggers skip and clears votes', () => {
  const room = makeRoom({ skipVotes: ['u2'] }); // 1 existing vote
  const result = registerVote(room, 'u3'); // 2nd vote → 2/3 > 1.5 → triggered
  assert.equal(result.triggered, true);
  assert.equal(result.votes, 2);
  assert.equal(result.total, 3);
  assert.deepEqual(room.skipVotes, []); // cleared on trigger
});

test('registerVote: same user voting twice is idempotent', () => {
  const room = makeRoom({ skipVotes: ['u2'] });
  const result = registerVote(room, 'u2'); // duplicate vote
  assert.equal(result.votes, 1); // still 1, not 2
  assert.equal(result.triggered, false);
});

test('registerVote: 2 members — single vote (50%) does not trigger', () => {
  const room = makeRoom({
    members: [{ id: 'u1', username: 'alice' }, { id: 'u2', username: 'bob' }],
    skipVotes: [],
  });
  const result = registerVote(room, 'u2'); // 1/2 = 50% = not >50%
  assert.equal(result.triggered, false);
  assert.equal(result.votes, 1);
  assert.equal(result.total, 2);
});
