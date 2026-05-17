import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCache, cacheKey } from '../src/yt-cache.js';

const mkTmpDir = (): string => {
  const dir = join(tmpdir(), `yt-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

test('cacheKey lowercases title and artist joined by space', () => {
  assert.equal(cacheKey('Bohemian Rhapsody', 'Queen'), 'bohemian rhapsody queen');
  assert.equal(cacheKey('SONG', 'ARTIST'), 'song artist');
});

test('get returns undefined for missing key', () => {
  const dir = mkTmpDir();
  try {
    const cache = loadCache(join(dir, 'cache.json'));
    assert.strictEqual(cache.get('missing key'), undefined);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('set/get roundtrip stores a youtube URL', () => {
  const dir = mkTmpDir();
  try {
    const cache = loadCache(join(dir, 'cache.json'));
    cache.set('bohemian rhapsody queen', 'https://www.youtube.com/watch?v=fJ9rUzIMcZQ');
    assert.equal(cache.get('bohemian rhapsody queen'), 'https://www.youtube.com/watch?v=fJ9rUzIMcZQ');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('set/get roundtrip stores null for a failed resolution', () => {
  const dir = mkTmpDir();
  try {
    const cache = loadCache(join(dir, 'cache.json'));
    cache.set('nonexistent track nobody', null);
    assert.strictEqual(cache.get('nonexistent track nobody'), null);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('cache persists to disk — second loadCache call reads what first one wrote', () => {
  const dir = mkTmpDir();
  try {
    const path = join(dir, 'cache.json');
    const cache1 = loadCache(path);
    cache1.set('key', 'https://example.com/video');
    const cache2 = loadCache(path);
    assert.equal(cache2.get('key'), 'https://example.com/video');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('loadCache survives a corrupt cache file', () => {
  const dir = mkTmpDir();
  try {
    const path = join(dir, 'cache.json');
    writeFileSync(path, 'not-valid-json', 'utf8');
    const cache = loadCache(path);
    assert.strictEqual(cache.get('any key'), undefined);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
