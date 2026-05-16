import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { rmSync } from 'node:fs';
import { computeDelay, sendMpvCommand } from '../src/playback-engine.js';

test('computeDelay returns positive ms when startAt is in the future', () => {
  assert.equal(computeDelay(1200, 1000), 200);
});

test('computeDelay returns 0 when startAt is in the past', () => {
  assert.equal(computeDelay(1000, 2000), 0);
});

test('computeDelay returns 0 when startAt equals now', () => {
  assert.equal(computeDelay(1000, 1000), 0);
});

test('computeDelay handles large future gaps', () => {
  assert.equal(computeDelay(5000, 1000), 4000);
});

test('sendMpvCommand writes JSON command to the socket', async () => {
  const socketPath = '/tmp/auxmpv-test.sock';
  rmSync(socketPath, { force: true });
  let received = '';

  const server: Server = await new Promise((resolve) => {
    const s = createServer((sock) => {
      sock.on('data', (chunk) => { received += chunk.toString(); });
    });
    s.listen(socketPath, () => resolve(s));
  });

  try {
    sendMpvCommand(socketPath, ['set_property', 'volume', 50]);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(received.trim(), JSON.stringify({ command: ['set_property', 'volume', 50] }));
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    rmSync(socketPath, { force: true });
  }
});
