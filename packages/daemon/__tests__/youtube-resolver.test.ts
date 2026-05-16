import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchYoutube, parseYtDlpOutput, type SearchResult } from '../src/youtube-resolver.js';

test('searchYoutube returns results with required fields', async () => {
  const results = await searchYoutube('daft punk harder better faster');
  assert.ok(Array.isArray(results), 'returns array');
  assert.ok(results.length > 0, 'returns at least one result');
  const r = results[0]! as SearchResult;
  assert.ok(typeof r.title === 'string' && r.title.length > 0, 'has title');
  assert.ok(typeof r.artist === 'string', 'has artist');
  assert.ok(typeof r.duration === 'number' && r.duration > 0, 'has positive duration');
  assert.ok(typeof r.youtubeUrl === 'string' && r.youtubeUrl.startsWith('http'), 'has url');
});

test('searchYoutube returns at most 5 results', async () => {
  const results = await searchYoutube('piano');
  assert.ok(results.length <= 5);
});

test('searchYoutube throws YT_DLP_NOT_FOUND if yt-dlp missing', async () => {
  const orig = process.env['PATH'];
  process.env['PATH'] = '/nonexistent';
  try {
    await assert.rejects(() => searchYoutube('test'), /YT_DLP_NOT_FOUND/);
  } finally {
    process.env['PATH'] = orig;
  }
});

test('parseYtDlpOutput returns empty array for empty stdout', () => {
  assert.deepEqual(parseYtDlpOutput(''), []);
});

test('parseYtDlpOutput returns empty array for blank lines (private/unavailable video)', () => {
  // yt-dlp outputs nothing or only whitespace for private/unavailable videos
  assert.deepEqual(parseYtDlpOutput('\n\n   \n'), []);
});

test('parseYtDlpOutput skips malformed JSON lines and returns empty array', () => {
  // Simulates yt-dlp error output lines for private/unavailable content
  const malformed = 'ERROR: Video unavailable\nWARNING: unable to download video\n';
  assert.deepEqual(parseYtDlpOutput(malformed), []);
});

test('parseYtDlpOutput parses a single valid JSON line into one result', () => {
  const entry = {
    title: 'Test Song',
    uploader: 'Test Artist',
    duration: 213,
    webpage_url: 'https://www.youtube.com/watch?v=abc123',
  };
  const results = parseYtDlpOutput(JSON.stringify(entry));
  assert.equal(results.length, 1);
  const r = results[0]!;
  assert.equal(r.title, 'Test Song');
  assert.equal(r.artist, 'Test Artist');
  assert.equal(r.duration, 213);
  assert.equal(r.youtubeUrl, 'https://www.youtube.com/watch?v=abc123');
});
