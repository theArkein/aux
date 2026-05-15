import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { initDb, closeDb } from '../src/db.js';
import { registerUser, loginUser } from '../src/auth.js';
import type { Database } from 'better-sqlite3';

let db: Database;

before(() => {
  db = initDb(':memory:');
});

after(() => {
  closeDb(db);
});

test('registerUser creates a new user and returns the user row', () => {
  const user = registerUser(db, 'alice', 'password123');
  assert.equal(user.username, 'alice');
  assert.ok(user.id, 'user should have an id');
  assert.ok(!('password_hash' in user), 'password_hash must not be returned');
});

test('registerUser throws if username is already taken', () => {
  registerUser(db, 'bob', 'pass');
  assert.throws(
    () => registerUser(db, 'bob', 'otherpass'),
    { message: 'USERNAME_TAKEN' }
  );
});

test('loginUser returns user row on correct password', () => {
  registerUser(db, 'carol', 'secret');
  const user = loginUser(db, 'carol', 'secret');
  assert.equal(user.username, 'carol');
  assert.ok(!('password_hash' in user), 'password_hash must not be returned');
});

test('loginUser throws on wrong password', () => {
  registerUser(db, 'dave', 'rightpass');
  assert.throws(
    () => loginUser(db, 'dave', 'wrongpass'),
    { message: 'INVALID_CREDENTIALS' }
  );
});

test('loginUser throws on unknown username', () => {
  assert.throws(
    () => loginUser(db, 'nobody', 'pass'),
    { message: 'INVALID_CREDENTIALS' }
  );
});
