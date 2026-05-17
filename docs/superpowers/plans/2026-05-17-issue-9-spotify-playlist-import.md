# Spotify Playlist Import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users import a Spotify playlist into the room queue via PKCE OAuth (no backend secret) from the TUI — browsing playlists, resolving each track to a YouTube URL via yt-dlp, and caching results locally to skip duplicate lookups.

**Architecture:** The daemon owns all Spotify API communication and YouTube resolution. The TUI sends IPC events (`spotify:playlists`, `spotify:import`) and renders progress received from the daemon. Resolved tracks are cached in `~/.aux/yt-cache.json`. The PKCE OAuth flow opens a local HTTP callback server on port 8888, then launches the system browser automatically. Client ID comes from the `SPOTIFY_CLIENT_ID` env var on the daemon.

**Tech Stack:** Node.js built-in `fetch` (Spotify REST API), `node:http` (OAuth callback server), `node:crypto` (PKCE SHA-256), `yt-dlp` (YouTube resolution via existing `searchYoutube`), `node:test` + `assert` (tests), TypeScript strict mode.

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `packages/daemon/src/yt-cache.ts` | JSON file cache: (title, artist) → YouTube URL or null |
| Create | `packages/daemon/src/spotify-client.ts` | PKCE helpers, token storage, Spotify REST calls, OAuth flow |
| Create | `packages/daemon/__tests__/yt-cache.test.ts` | Unit tests for cache module |
| Create | `packages/daemon/__tests__/spotify-client.test.ts` | Unit tests for pure functions in spotify-client |
| Modify | `packages/daemon/bin/auxd.ts` | Add spotify:playlists + spotify:import IPC handlers; init ytCache |
| Modify | `packages/client/src/App.tsx` | Add Spotify modes (loading, playlists, importing) + `p` keybinding |

---

### Task 1: yt-cache module

**Files:**
- Create: `packages/daemon/__tests__/yt-cache.test.ts`
- Create: `packages/daemon/src/yt-cache.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/daemon/__tests__/yt-cache.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/daemon && npm test -- --test-name-pattern 'yt-cache'
```

Expected: FAIL — `Cannot find module '../src/yt-cache.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/daemon/src/yt-cache.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_CACHE_PATH = join(homedir(), '.aux', 'yt-cache.json');

export type CacheValue = string | null;

export interface YtCache {
  get(key: string): CacheValue | undefined;
  set(key: string, value: CacheValue): void;
}

export function cacheKey(title: string, artist: string): string {
  return `${title} ${artist}`.toLowerCase();
}

export function loadCache(path = DEFAULT_CACHE_PATH): YtCache {
  let data: Record<string, CacheValue> = {};

  if (existsSync(path)) {
    try {
      data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, CacheValue>;
    } catch {
      data = {};
    }
  }

  const save = (): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data), 'utf8');
  };

  return {
    get: (key) => data[key],
    set: (key, value) => { data[key] = value; save(); },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/daemon && npm test -- --test-name-pattern 'yt-cache'
```

Expected: all 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/yt-cache.ts packages/daemon/__tests__/yt-cache.test.ts
git commit -m "feat(daemon): add yt-cache module for local YouTube resolution cache"
```

---

### Task 2: spotify-client module — pure functions + OAuth

**Files:**
- Create: `packages/daemon/__tests__/spotify-client.test.ts`
- Create: `packages/daemon/src/spotify-client.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/daemon/__tests__/spotify-client.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/daemon && npm test -- --test-name-pattern 'spotify'
```

Expected: FAIL — `Cannot find module '../src/spotify-client.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// packages/daemon/src/spotify-client.ts
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { exec } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const REDIRECT_URI = 'http://localhost:8888/callback';
const SCOPES = 'playlist-read-private playlist-read-collaborative';
const DEFAULT_TOKEN_PATH = join(homedir(), '.aux', 'spotify-token.json');

export interface SpotifyToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  trackCount: number;
}

export interface SpotifyTrack {
  title: string;
  artist: string;
  durationMs: number;
}

export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function buildAuthUrl(codeChallenge: string, state: string, clientId: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    state,
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

export function saveToken(token: SpotifyToken, path = DEFAULT_TOKEN_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(token), 'utf8');
}

export function loadToken(path = DEFAULT_TOKEN_PATH): SpotifyToken | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SpotifyToken;
  } catch {
    return null;
  }
}

type SpotifyPlaylistsPage = {
  items: Array<{ id: string; name: string; tracks: { total: number } }>;
  next: string | null;
};

type SpotifyTracksPage = {
  items: Array<{ track: { name: string; artists: Array<{ name: string }>; duration_ms: number } | null }>;
  next: string | null;
};

export function parseSpotifyPlaylists(data: SpotifyPlaylistsPage): SpotifyPlaylist[] {
  return data.items.map((item) => ({
    id: item.id,
    name: item.name,
    trackCount: item.tracks.total,
  }));
}

export function parseSpotifyTracks(data: SpotifyTracksPage): SpotifyTrack[] {
  return data.items
    .filter((item): item is { track: NonNullable<typeof item.track> } => item.track !== null)
    .map((item) => ({
      title: item.track.name,
      artist: item.track.artists[0]?.name ?? 'Unknown',
      durationMs: item.track.duration_ms,
    }));
}

async function spotifyFetch<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`SPOTIFY_API_ERROR: ${res.status}`);
  return res.json() as Promise<T>;
}

export async function fetchPlaylists(accessToken: string): Promise<SpotifyPlaylist[]> {
  const playlists: SpotifyPlaylist[] = [];
  let url: string | null = 'https://api.spotify.com/v1/me/playlists?limit=50';
  while (url) {
    const page = await spotifyFetch<SpotifyPlaylistsPage>(url, accessToken);
    playlists.push(...parseSpotifyPlaylists(page));
    url = page.next;
  }
  return playlists;
}

export async function fetchPlaylistTracks(accessToken: string, playlistId: string): Promise<SpotifyTrack[]> {
  const tracks: SpotifyTrack[] = [];
  let url: string | null =
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&fields=items(track(name,artists,duration_ms)),next`;
  while (url) {
    const page = await spotifyFetch<SpotifyTracksPage>(url, accessToken);
    tracks.push(...parseSpotifyTracks(page));
    url = page.next;
  }
  return tracks;
}

async function exchangeCode(code: string, verifier: string, clientId: string): Promise<SpotifyToken> {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`SPOTIFY_TOKEN_ERROR: ${res.status}`);
  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

export async function refreshAccessToken(
  token: SpotifyToken,
  clientId: string,
  path = DEFAULT_TOKEN_PATH
): Promise<SpotifyToken> {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
  });
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`SPOTIFY_REFRESH_ERROR: ${res.status}`);
  const data = await res.json() as { access_token: string; refresh_token?: string; expires_in: number };
  const updated: SpotifyToken = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? token.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  saveToken(updated, path);
  return updated;
}

export async function getValidToken(clientId: string, path = DEFAULT_TOKEN_PATH): Promise<SpotifyToken | null> {
  let token = loadToken(path);
  if (!token) return null;
  if (Date.now() > token.expires_at - 60_000) {
    token = await refreshAccessToken(token, clientId, path);
  }
  return token;
}

export interface OAuthFlowOptions {
  clientId: string;
  tokenPath?: string;
  onUrl?: (url: string) => void;
}

export function startOAuthFlow({ clientId, tokenPath, onUrl }: OAuthFlowOptions): Promise<SpotifyToken> {
  return new Promise((resolve, reject) => {
    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);
    const state = randomBytes(8).toString('hex');
    const authUrl = buildAuthUrl(challenge, state, clientId);

    const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${openCmd} ${JSON.stringify(authUrl)}`);
    onUrl?.(authUrl);

    const server = createServer(async (req, res) => {
      if (!req.url?.startsWith('/callback')) { res.end(); return; }

      const callbackUrl = new URL(req.url, 'http://localhost:8888');
      const code = callbackUrl.searchParams.get('code');
      const returnedState = callbackUrl.searchParams.get('state');

      const ok = code !== null && returnedState === state;
      res.end(ok ? 'Spotify auth successful! You can close this tab.' : 'Auth failed. You can close this tab.');
      server.close();

      if (!ok) { reject(new Error('SPOTIFY_AUTH_INVALID_CALLBACK')); return; }

      try {
        const token = await exchangeCode(code, verifier, clientId);
        saveToken(token, tokenPath);
        resolve(token);
      } catch (err) {
        reject(err);
      }
    });

    server.on('error', reject);
    server.listen(8888, 'localhost');
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/daemon && npm test -- --test-name-pattern 'spotify'
```

Expected: all 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/spotify-client.ts packages/daemon/__tests__/spotify-client.test.ts
git commit -m "feat(daemon): add spotify-client module — PKCE OAuth, token storage, playlist/track fetch"
```

---

### Task 3: Daemon IPC handlers for Spotify

**Files:**
- Modify: `packages/daemon/bin/auxd.ts`

- [ ] **Step 1: Add imports and ytCache initialisation near the top of auxd.ts**

After the existing imports block (after the `import { searchYoutube }` line), add:

```typescript
import { loadCache, cacheKey } from '../src/yt-cache.js';
import {
  getValidToken,
  startOAuthFlow,
  fetchPlaylists,
  fetchPlaylistTracks,
} from '../src/spotify-client.js';
```

After the `const tuiClients = new Set<Socket>();` line, add:

```typescript
const ytCache = loadCache();
```

- [ ] **Step 2: Add `spotify:playlists` handler inside `handleIpcMessage`**

At the end of the `handleIpcMessage` function body (before the closing `}`), add:

```typescript
  if (msg['event'] === 'spotify:playlists') {
    const clientId = process.env['SPOTIFY_CLIENT_ID'] ?? '';
    if (!clientId) {
      replyToSocket(socket, {
        event: 'spotify:error',
        code: 'SPOTIFY_CLIENT_ID_NOT_SET',
        message: 'Set SPOTIFY_CLIENT_ID env var. Create an app at https://developer.spotify.com/dashboard',
      });
      return;
    }
    try {
      let token = await getValidToken(clientId);
      if (!token) {
        token = await startOAuthFlow({
          clientId,
          onUrl: (url) => replyToSocket(socket, { event: 'spotify:auth:url', url }),
        });
        replyToSocket(socket, { event: 'spotify:auth:ok' });
      }
      const playlists = await fetchPlaylists(token.access_token);
      replyToSocket(socket, { event: 'spotify:playlists', playlists });
    } catch (err) {
      replyToSocket(socket, { event: 'spotify:error', code: (err as Error).message });
    }
    return;
  }
```

- [ ] **Step 3: Add `spotify:import` handler inside `handleIpcMessage`**

Immediately after the block you just added, still inside `handleIpcMessage`, add:

```typescript
  if (msg['event'] === 'spotify:import') {
    const playlistId = String(msg['playlistId'] ?? '');
    if (!playlistId) {
      replyToSocket(socket, { event: 'spotify:error', code: 'MISSING_PLAYLIST_ID' });
      return;
    }
    const clientId = process.env['SPOTIFY_CLIENT_ID'] ?? '';
    const token = await getValidToken(clientId);
    if (!token) {
      replyToSocket(socket, { event: 'spotify:error', code: 'NOT_AUTHENTICATED' });
      return;
    }
    try {
      const spotifyTracks = await fetchPlaylistTracks(token.access_token, playlistId);
      const total = spotifyTracks.length;
      let resolved = 0;
      let failed = 0;
      replyToSocket(socket, { event: 'spotify:import:progress', resolved: 0, total, failed: 0 });

      for (const st of spotifyTracks) {
        const key = cacheKey(st.title, st.artist);
        let youtubeUrl = ytCache.get(key);

        if (youtubeUrl === undefined) {
          try {
            const results = await searchYoutube(`${st.title} ${st.artist}`, 1);
            youtubeUrl = results[0]?.youtubeUrl ?? null;
          } catch {
            youtubeUrl = null;
          }
          ytCache.set(key, youtubeUrl);
        }

        if (youtubeUrl) {
          wsClient.send({
            event: 'queue:add',
            youtubeUrl,
            title: st.title,
            artist: st.artist,
            duration: Math.round(st.durationMs / 1000),
          });
          resolved++;
        } else {
          failed++;
        }
        replyToSocket(socket, { event: 'spotify:import:progress', resolved, total, failed });
      }
      replyToSocket(socket, { event: 'spotify:import:done', queued: resolved, failed });
    } catch (err) {
      replyToSocket(socket, { event: 'spotify:error', code: (err as Error).message });
    }
    return;
  }
```

- [ ] **Step 4: Type-check the daemon**

```bash
cd packages/daemon && npx tsc --noEmit
```

Expected: no errors. Fix any type errors before continuing.

- [ ] **Step 5: Run all daemon tests**

```bash
cd packages/daemon && npm test
```

Expected: all existing tests pass (no regressions).

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/bin/auxd.ts
git commit -m "feat(daemon): add spotify:playlists and spotify:import IPC handlers"
```

---

### Task 4: TUI — Spotify modes

**Files:**
- Modify: `packages/client/src/App.tsx`

- [ ] **Step 1: Add new interfaces and extend the `Mode` type**

In the interfaces section of `App.tsx` (near the other interfaces), add:

```typescript
interface SpotifyPlaylist {
  id: string;
  name: string;
  trackCount: number;
}

interface SpotifyProgress {
  resolved: number;
  total: number;
  failed: number;
}
```

Change the existing `Mode` type from:

```typescript
type Mode = 'normal' | 'typing' | 'results';
```

to:

```typescript
type Mode = 'normal' | 'typing' | 'results' | 'spotify-loading' | 'spotify-playlists' | 'spotify-importing';
```

- [ ] **Step 2: Add Spotify state variables**

Inside the `App` function, after the existing `useState` calls, add:

```typescript
  const [spotifyPlaylists, setSpotifyPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [selectedPlaylistIdx, setSelectedPlaylistIdx] = useState(0);
  const [spotifyAuthUrl, setSpotifyAuthUrl] = useState<string | null>(null);
  const [spotifyProgress, setSpotifyProgress] = useState<SpotifyProgress | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
```

- [ ] **Step 3: Handle incoming Spotify IPC events**

Inside the `onMessage` callback (inside `useEffect` / `createIpcClient`), after the existing `if (m['event'] === 'friends:list' ...)` block, add:

```typescript
        if (m['event'] === 'spotify:auth:url') {
          setSpotifyAuthUrl(String(m['url'] ?? ''));
          setMode('spotify-loading');
        }

        if (m['event'] === 'spotify:auth:ok') {
          setSpotifyAuthUrl(null);
        }

        if (m['event'] === 'spotify:playlists' && Array.isArray(m['playlists'])) {
          setSpotifyPlaylists(m['playlists'] as SpotifyPlaylist[]);
          setSelectedPlaylistIdx(0);
          setMode('spotify-playlists');
        }

        if (m['event'] === 'spotify:import:progress') {
          setSpotifyProgress({
            resolved: Number(m['resolved']),
            total: Number(m['total']),
            failed: Number(m['failed']),
          });
          setMode('spotify-importing');
        }

        if (m['event'] === 'spotify:import:done') {
          setSpotifyProgress(null);
          setMode('normal');
          setStatusMsg(`Spotify import: ${Number(m['queued'])} queued, ${Number(m['failed'])} failed`);
        }

        if (m['event'] === 'spotify:error') {
          setMode('normal');
          setStatusMsg(String(m['message'] ?? m['code'] ?? 'Spotify error'));
        }
```

- [ ] **Step 4: Add `p` keybinding and Spotify mode input handling**

Inside `useInput`, in the `if (mode === 'normal')` block, after the `if (input === 'x')` block, add:

```typescript
      if (input === 'p') {
        setSpotifyAuthUrl(null);
        setSpotifyProgress(null);
        setStatusMsg(null);
        setMode('spotify-loading');
        clientRef.current?.send({ event: 'spotify:playlists' });
        return;
      }
```

After the closing `}` of the `if (mode === 'results')` block (at the end of `useInput`), add:

```typescript
    if (mode === 'spotify-loading' || mode === 'spotify-importing') {
      if (key.escape) { setMode('normal'); return; }
    }

    if (mode === 'spotify-playlists') {
      if (key.escape) { setMode('normal'); return; }
      if (key.upArrow) { setSelectedPlaylistIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) {
        setSelectedPlaylistIdx((i) => Math.min(spotifyPlaylists.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const playlist = spotifyPlaylists[selectedPlaylistIdx];
        if (playlist) {
          setSpotifyProgress({ resolved: 0, total: playlist.trackCount, failed: 0 });
          setMode('spotify-importing');
          clientRef.current?.send({ event: 'spotify:import', playlistId: playlist.id });
        }
        return;
      }
    }
```

- [ ] **Step 5: Render Spotify overlays**

In the `return` statement of `App`, replace the existing check:

```typescript
  const searchOverlay = mode === 'typing' || mode === 'results';
```

with:

```typescript
  const searchOverlay = mode === 'typing' || mode === 'results';
  const spotifyOverlay = mode === 'spotify-loading' || mode === 'spotify-playlists' || mode === 'spotify-importing';
```

In the JSX, after the `<Box marginBottom={1}>` header block and before the `{searchOverlay ? (` ternary, add Spotify overlay rendering. Replace the entire `return (...)` with:

```tsx
  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>aux</Text>
        {room && <Text dimColor>  room: {room.name}</Text>}
      </Box>

      {mode === 'spotify-loading' && (
        <Box flexDirection="column">
          {spotifyAuthUrl ? (
            <>
              <Text>Opening Spotify auth in browser...</Text>
              <Text dimColor>If browser did not open, visit:</Text>
              <Text color="cyan">{spotifyAuthUrl}</Text>
            </>
          ) : (
            <Text>Loading Spotify playlists...</Text>
          )}
          <Box marginTop={1}><Text dimColor>Esc: cancel</Text></Box>
        </Box>
      )}

      {mode === 'spotify-playlists' && (
        <Box flexDirection="column">
          <Text bold color="cyan">Spotify Playlists</Text>
          <Box marginTop={1} flexDirection="column">
            {spotifyPlaylists.length === 0
              ? <Text dimColor>No playlists found</Text>
              : spotifyPlaylists.map((pl, i) => (
                  <Box key={pl.id}>
                    <Text color={i === selectedPlaylistIdx ? 'cyan' : undefined}>
                      {i === selectedPlaylistIdx ? '▶ ' : '  '}
                      {pl.name} ({pl.trackCount} tracks)
                    </Text>
                  </Box>
                ))}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>↑↓: navigate  Enter: import playlist  Esc: cancel</Text>
          </Box>
        </Box>
      )}

      {mode === 'spotify-importing' && (
        <Box flexDirection="column">
          <Text bold color="cyan">Importing Spotify playlist...</Text>
          {spotifyProgress && (
            <Box flexDirection="column" marginTop={1}>
              <Text>Resolved: {spotifyProgress.resolved} / {spotifyProgress.total}</Text>
              {spotifyProgress.failed > 0 && (
                <Text color="yellow">Skipped (no YouTube match): {spotifyProgress.failed}</Text>
              )}
            </Box>
          )}
          <Box marginTop={1}><Text dimColor>Esc: cancel</Text></Box>
        </Box>
      )}

      {!spotifyOverlay && searchOverlay && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold color="cyan">Search: </Text>
            <Text>{query}{mode === 'typing' ? '█' : ''}</Text>
          </Box>
          {mode === 'results' && results.length === 0 && (
            <Text dimColor>No results</Text>
          )}
          {mode === 'results' && results.map((r, i) => (
            <Box key={r.youtubeUrl}>
              <Text color={i === selectedIdx ? 'cyan' : undefined}>
                {i === selectedIdx ? '▶ ' : '  '}
                {r.title} — {r.artist} ({formatDuration(r.duration)})
              </Text>
            </Box>
          ))}
          <Box marginTop={1}>
            <Text dimColor>
              {mode === 'typing' ? 'Enter: search  Esc: cancel' : '↑↓: navigate  Enter: queue  Esc: cancel'}
            </Text>
          </Box>
        </Box>
      )}

      {!spotifyOverlay && !searchOverlay && (
        <>
          <Box gap={1}>
            <PanelBox title="Now Playing" focused={focused === 'nowPlaying'}>
              {playback ? (
                <Box flexDirection="column">
                  <Text>{playback.track.title}</Text>
                  <Text dimColor>{playback.track.artist}</Text>
                  <Box marginTop={1}>
                    <Text>[{progressBar(clampedElapsed, playback.track.duration)}]</Text>
                  </Box>
                  <Text dimColor>
                    {formatDuration(clampedElapsed)} / {formatDuration(playback.track.duration)}
                  </Text>
                  {room && room.skipVotes.length > 0 && (
                    <Text color="yellow">
                      {room.skipVotes.length}/{room.members.length} votes to skip
                    </Text>
                  )}
                </Box>
              ) : (
                <Text dimColor>{room ? 'Nothing playing' : 'Not in a room'}</Text>
              )}
            </PanelBox>
            <PanelBox title="Queue" focused={focused === 'queue'}>
              {room && room.queue.length > 0
                ? room.queue.map((t) => (
                    <Text key={t.id}>
                      {t.title}
                      {t.duration ? ` (${formatDuration(t.duration)})` : ''}
                      {` · ${t.queuedBy}`}
                    </Text>
                  ))
                : <Text dimColor>Queue is empty</Text>}
            </PanelBox>
            <PanelBox title="Members" focused={focused === 'members'}>
              {room && room.members.length > 0
                ? room.members.map((m) => (
                    <Text key={m.id}>
                      {m.username}{m.isGuest ? <Text dimColor> (guest)</Text> : null}
                    </Text>
                  ))
                : <Text dimColor>No members</Text>}
            </PanelBox>
            <PanelBox title="Friends" focused={focused === 'friends'}>
              {friends.length > 0
                ? friends.map((f, i) => (
                    <Box key={f.id}>
                      <Text color={focused === 'friends' && i === selectedFriendIdx ? 'cyan' : undefined}>
                        {focused === 'friends' && i === selectedFriendIdx ? '▶ ' : '  '}
                        {f.username}
                        {f.status === 'online'
                          ? <Text color="green">{f.roomName ? ` ● ${f.roomName}` : ' ●'}</Text>
                          : <Text dimColor> ○</Text>}
                      </Text>
                    </Box>
                  ))
                : <Text dimColor>No friends</Text>}
            </PanelBox>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>
              {'Tab: switch panel  ·  s: search  ·  p: Spotify import  ·  x: skip  ·  +/-: volume  ·  q: quit TUI'}
              {focused === 'friends' && friends[selectedFriendIdx]?.roomName ? '  ·  Enter: join room' : ''}
            </Text>
            {statusMsg && <Text color="yellow">{statusMsg}</Text>}
          </Box>
        </>
      )}
    </Box>
  );
```

- [ ] **Step 6: Type-check the client**

```bash
cd packages/client && npx tsc --noEmit
```

Expected: no errors. Fix any type errors before continuing.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/App.tsx
git commit -m "feat(client): add Spotify import UI — playlist browser, progress overlay, p keybinding"
```

---

## Self-Review

### Spec coverage

| Requirement | Task |
|-------------|------|
| Spotify auth opens a local browser callback and stores the access token | Task 2 (`startOAuthFlow`), Task 3 (`spotify:playlists` handler) |
| User can browse and select a Spotify playlist from the TUI | Task 4 (`spotify-playlists` mode) |
| Each Spotify track resolves to a YouTube URL via yt-dlp search | Task 3 (`spotify:import` handler, `searchYoutube` call) |
| Resolved tracks appear in the room queue | Task 3 (`wsClient.send({ event: 'queue:add', ... })`) |
| Local cache prevents duplicate yt-dlp lookups | Task 1 (yt-cache), Task 3 (`ytCache.get/set`) |
| Tracks that fail to resolve are skipped with a warning shown in TUI | Task 3 (`failed++`), Task 4 (`Skipped` count in import overlay) |

### Placeholder scan

No TBD, TODO, or "similar to Task N" patterns. All code blocks contain complete implementations.

### Type consistency

- `SpotifyTrack.durationMs` defined in Task 2, used in Task 3 as `st.durationMs` ✓
- `SpotifyPlaylist` interface defined in Task 2, referenced as `SpotifyPlaylist[]` in Task 3 IPC reply and Task 4 TUI state ✓
- `cacheKey` exported from `yt-cache.ts` in Task 1, imported in Task 3 ✓
- `YtCache.get` returns `CacheValue | undefined`; Task 3 checks `=== undefined` before treating as cache miss ✓
