import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveCredentials, loadCredentials, clearCredentials } from '../src/credentials.js';

const testDir = join(tmpdir(), `aux-test-${Date.now()}`);

before(() => mkdirSync(testDir, { recursive: true }));
after(() => rmSync(testDir, { recursive: true, force: true }));

test('saveCredentials writes token and username to file', () => {
  saveCredentials({ token: 'tok123', username: 'alice', dir: testDir });
  const creds = loadCredentials({ dir: testDir });
  assert.equal(creds?.token, 'tok123');
  assert.equal(creds?.username, 'alice');
});

test('loadCredentials returns null when file does not exist', () => {
  const emptyDir = join(testDir, 'empty');
  mkdirSync(emptyDir);
  const creds = loadCredentials({ dir: emptyDir });
  assert.equal(creds, null);
});

test('clearCredentials removes the credentials file', () => {
  const clearDir = join(testDir, 'clear');
  mkdirSync(clearDir);
  saveCredentials({ token: 'tok', username: 'bob', dir: clearDir });
  clearCredentials({ dir: clearDir });
  const creds = loadCredentials({ dir: clearDir });
  assert.equal(creds, null);
});
