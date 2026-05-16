import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeDelay } from '../src/playback-engine.js';

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
