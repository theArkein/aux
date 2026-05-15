import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Room } from '../src/types.js';
import {
  createRoom,
  joinRoom,
  leaveRoom,
  getRoomByName,
  validateRoomName,
} from '../src/rooms.js';

test('validateRoomName accepts valid names', () => {
  assert.doesNotThrow(() => validateRoomName('apple'));
  assert.doesNotThrow(() => validateRoomName('abc'));
  assert.doesNotThrow(() => validateRoomName('12345678901234567890'));
});

test('validateRoomName rejects invalid names', () => {
  assert.throws(() => validateRoomName('ab'), { message: 'INVALID_ROOM_NAME' });
  assert.throws(() => validateRoomName('a'.repeat(21)), { message: 'INVALID_ROOM_NAME' });
  assert.throws(() => validateRoomName('Hello'), { message: 'INVALID_ROOM_NAME' });
  assert.throws(() => validateRoomName('has space'), { message: 'INVALID_ROOM_NAME' });
  assert.throws(() => validateRoomName('has-dash'), { message: 'INVALID_ROOM_NAME' });
});

test('createRoom creates room with host as first member', () => {
  const rooms = new Map<string, Room>();
  const room = createRoom(rooms, 'apple', { id: 'u1', username: 'alice' });
  assert.equal(room.name, 'apple');
  assert.equal(room.hostId, 'u1');
  assert.equal(room.members.length, 1);
  assert.equal(room.members[0]!.username, 'alice');
  assert.equal(rooms.size, 1);
});

test('createRoom throws ROOM_NAME_TAKEN on duplicate', () => {
  const rooms = new Map<string, Room>();
  createRoom(rooms, 'apple', { id: 'u1', username: 'alice' });
  assert.throws(
    () => createRoom(rooms, 'apple', { id: 'u2', username: 'bob' }),
    { message: 'ROOM_NAME_TAKEN' }
  );
});

test('joinRoom adds member to existing room', () => {
  const rooms = new Map<string, Room>();
  createRoom(rooms, 'apple', { id: 'u1', username: 'alice' });
  const room = joinRoom(rooms, 'apple', { id: 'u2', username: 'bob' });
  assert.equal(room.members.length, 2);
  assert.ok(room.members.some((m) => m.username === 'bob'));
});

test('joinRoom is idempotent for existing member', () => {
  const rooms = new Map<string, Room>();
  createRoom(rooms, 'apple', { id: 'u1', username: 'alice' });
  joinRoom(rooms, 'apple', { id: 'u1', username: 'alice' });
  const room = getRoomByName(rooms, 'apple')!;
  assert.equal(room.members.length, 1);
});

test('joinRoom throws ROOM_NOT_FOUND for unknown room', () => {
  const rooms = new Map<string, Room>();
  assert.throws(
    () => joinRoom(rooms, 'ghost', { id: 'u1', username: 'alice' }),
    { message: 'ROOM_NOT_FOUND' }
  );
});

test('leaveRoom removes member and transfers host on host leave', () => {
  const rooms = new Map<string, Room>();
  const room = createRoom(rooms, 'apple', { id: 'u1', username: 'alice' });
  joinRoom(rooms, 'apple', { id: 'u2', username: 'bob' });
  const updated = leaveRoom(rooms, room.id, 'u1');
  assert.ok(updated !== null);
  assert.equal(updated!.hostId, 'u2');
  assert.equal(updated!.members.length, 1);
});

test('leaveRoom deletes room when last member leaves', () => {
  const rooms = new Map<string, Room>();
  const room = createRoom(rooms, 'apple', { id: 'u1', username: 'alice' });
  const result = leaveRoom(rooms, room.id, 'u1');
  assert.equal(result, null);
  assert.equal(rooms.size, 0);
});
