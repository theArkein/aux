import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  buildAuthUrl,
  saveToken,
  loadToken,
  parseSpotifyPlaylists,
  parseSpotifyTracks,
  type SpotifyToken,
} from '../src/spotify-client.js';

const mkTmpDir = (): string => {
  const dir = join(tmpdir(), `spotify-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

test('generateCodeVerifier returns a base64url string between 43 and 128 chars', () => {
  const v = generateCodeVerifier();
  assert.ok(v.length >= 43 && v.length <= 128, `length ${v.length} not in [43, 128]`);
  assert.match(v, /^[A-Za-z0-9_-]+$/, 'not base64url');
});

test('generateCodeChallenge returns non-empty base64url (no padding)', () => {
  const challenge = generateCodeChallenge(generateCodeVerifier());
  assert.ok(challenge.length > 0);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
  assert.ok(!challenge.includes('='), 'should not have base64 padding');
});

test('buildAuthUrl includes all required OAuth PKCE params', () => {
  const url = buildAuthUrl('mychallenge', 'mystate', 'myclientid');
  assert.ok(url.startsWith('https://accounts.spotify.com/authorize'));
  assert.ok(url.includes('code_challenge=mychallenge'));
  assert.ok(url.includes('state=mystate'));
  assert.ok(url.includes('client_id=myclientid'));
  assert.ok(url.includes('code_challenge_method=S256'));
  assert.ok(url.includes('response_type=code'));
  assert.ok(url.includes('redirect_uri='));
});

test('saveToken/loadToken roundtrip preserves all fields', () => {
  const dir = mkTmpDir();
  try {
    const path = join(dir, 'token.json');
    const token: SpotifyToken = {
      access_token: 'BQA',
      refresh_token: 'AqA',
      expires_at: 9_999_999_999_999,
    };
    saveToken(token, path);
    assert.deepEqual(loadToken(path), token);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('loadToken returns null for missing file', () => {
  assert.strictEqual(loadToken('/nonexistent/path/spotify-token.json'), null);
});

test('loadToken returns null for corrupt token file', () => {
  const dir = mkTmpDir();
  try {
    const path = join(dir, 'bad.json');
    writeFileSync(path, 'not json', 'utf8');
    assert.strictEqual(loadToken(path), null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('parseSpotifyPlaylists extracts id, name, trackCount from API response shape', () => {
  const response = {
    items: [
      { id: 'pl1', name: 'Chill Vibes', tracks: { total: 42 } },
      { id: 'pl2', name: 'Hype Train', tracks: { total: 10 } },
    ],
    next: null,
  };
  assert.deepEqual(parseSpotifyPlaylists(response), [
    { id: 'pl1', name: 'Chill Vibes', trackCount: 42 },
    { id: 'pl2', name: 'Hype Train', trackCount: 10 },
  ]);
});

test('parseSpotifyTracks extracts title, first artist name, and durationMs; skips null tracks (local files)', () => {
  const response = {
    items: [
      { track: { name: 'Bohemian Rhapsody', artists: [{ name: 'Queen' }], duration_ms: 354000 } },
      { track: null },
      { track: { name: 'Song 2', artists: [{ name: 'Blur' }, { name: 'Other' }], duration_ms: 121000 } },
    ],
    next: null,
  };
  assert.deepEqual(parseSpotifyTracks(response), [
    { title: 'Bohemian Rhapsody', artist: 'Queen', durationMs: 354000 },
    { title: 'Song 2', artist: 'Blur', durationMs: 121000 },
  ]);
});

test('parseSpotifyTracks uses "Unknown" when artists array is empty', () => {
  const response = {
    items: [
      { track: { name: 'Mystery Track', artists: [], duration_ms: 0 } },
    ],
    next: null,
  };
  const [track] = parseSpotifyTracks(response);
  assert.equal(track?.artist, 'Unknown');
});
