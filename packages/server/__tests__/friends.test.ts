import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../src/db.js';
import { registerUser } from '../src/auth.js';
import { addFriend, getFriends } from '../src/friends.js';
import type Database from 'better-sqlite3';

let db: Database.Database;

before(() => {
  db = initDb(':memory:');
  registerUser(db, 'alice', 'pass');
  registerUser(db, 'bob', 'pass');
  registerUser(db, 'carol', 'pass');
});

after(() => {
  closeDb(db);
});

test('addFriend returns the friend User', () => {
  const alice = db.prepare('SELECT id FROM users WHERE username = ?').get('alice') as { id: string };
  const friend = addFriend(db, alice.id, 'bob');
  assert.equal(friend.username, 'bob');
  assert.ok(friend.id);
});

test('addFriend throws UNKNOWN_USER for nonexistent username', () => {
  const alice = db.prepare('SELECT id FROM users WHERE username = ?').get('alice') as { id: string };
  assert.throws(() => addFriend(db, alice.id, 'nobody'), { message: 'UNKNOWN_USER' });
});

test('addFriend throws SELF_FRIEND when adding yourself', () => {
  const alice = db.prepare('SELECT id FROM users WHERE username = ?').get('alice') as { id: string };
  assert.throws(() => addFriend(db, alice.id, 'alice'), { message: 'SELF_FRIEND' });
});

test('addFriend throws ALREADY_FRIENDS on duplicate', () => {
  const alice = db.prepare('SELECT id FROM users WHERE username = ?').get('alice') as { id: string };
  addFriend(db, alice.id, 'carol');
  assert.throws(() => addFriend(db, alice.id, 'carol'), { message: 'ALREADY_FRIENDS' });
});

test('getFriends returns friends added by userId', () => {
  const alice = db.prepare('SELECT id FROM users WHERE username = ?').get('alice') as { id: string };
  const friends = getFriends(db, alice.id);
  const names = friends.map((f) => f.username).sort();
  assert.ok(names.includes('bob'));
  assert.ok(names.includes('carol'));
});

test('getFriends returns empty array for user with no friends', () => {
  const bob = db.prepare('SELECT id FROM users WHERE username = ?').get('bob') as { id: string };
  const friends = getFriends(db, bob.id);
  assert.equal(friends.length, 0);
});
