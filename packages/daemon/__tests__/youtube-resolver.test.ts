import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchYoutube, parseDuration, type SearchResult } from '../src/youtube-resolver.js';

test('searchYoutube returns results with required fields', async () => {
  const results = await searchYoutube('daft punk harder better faster');
  assert.ok(Array.isArray(results), 'returns array');
  assert.ok(results.length > 0, 'returns at least one result');
  const r = results[0]! as SearchResult;
  assert.ok(typeof r.title === 'string' && r.title.length > 0, 'has title');
  assert.ok(typeof r.artist === 'string', 'has artist');
  assert.ok(typeof r.duration === 'number' && r.duration > 0, 'has positive duration');
  assert.ok(typeof r.youtubeUrl === 'string' && r.youtubeUrl.startsWith('https://www.youtube.com/watch?v='), 'has url');
});

test('searchYoutube returns at most 5 results', async () => {
  const results = await searchYoutube('piano');
  assert.ok(results.length <= 5);
});

test('parseDuration parses MM:SS', () => {
  assert.equal(parseDuration('6:00'), 360);
  assert.equal(parseDuration('3:45'), 225);
  assert.equal(parseDuration('0:30'), 30);
});

test('parseDuration parses HH:MM:SS', () => {
  assert.equal(parseDuration('1:30:00'), 5400);
  assert.equal(parseDuration('2:05:10'), 7510);
});

test('parseDuration returns 0 for unrecognised input', () => {
  assert.equal(parseDuration('0:00'), 0);
});
