import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';

// ─── Exported types ───────────────────────────────────────────────────────────

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

export interface OAuthFlowOptions {
  clientId: string;
  tokenPath?: string;
  onUrl?: (url: string) => void;
}

// ─── Internal types ───────────────────────────────────────────────────────────

type SpotifyPlaylistsPage = {
  items: Array<{ id: string; name: string; tracks: { total: number } }>;
  next: string | null;
};

type SpotifyTracksPage = {
  items: Array<{
    track: { name: string; artists: Array<{ name: string }>; duration_ms: number } | null;
  }>;
  next: string | null;
};

// ─── Constants ────────────────────────────────────────────────────────────────

const SPOTIFY_AUTH_BASE = 'https://accounts.spotify.com';
const SPOTIFY_API_BASE = 'https://api.spotify.com';
const REDIRECT_URI = 'http://localhost:8888/callback';
const SCOPES = 'playlist-read-private playlist-read-collaborative';
const DEFAULT_TOKEN_PATH = join(homedir(), '.aux', 'spotify-token.json');

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

/** Generates a 32-byte random value encoded as base64url (no padding). */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 of the verifier, base64url-encoded (no `=` padding). */
export function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Builds the Spotify authorization URL with PKCE parameters. */
export function buildAuthUrl(codeChallenge: string, state: string, clientId: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
  });
  return `${SPOTIFY_AUTH_BASE}/authorize?${params.toString()}`;
}

// ─── Token storage ────────────────────────────────────────────────────────────

/** Writes a SpotifyToken to disk as JSON; creates parent directories as needed. */
export function saveToken(token: SpotifyToken, path: string = DEFAULT_TOKEN_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(token, null, 2), 'utf8');
}

/** Reads a SpotifyToken from disk; returns null if the file is missing or contains invalid JSON. */
export function loadToken(path: string = DEFAULT_TOKEN_PATH): SpotifyToken | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as SpotifyToken;
    // Basic shape validation
    if (
      typeof parsed.access_token !== 'string' ||
      typeof parsed.refresh_token !== 'string' ||
      !Number.isFinite(parsed.expires_at)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// ─── Parse helpers ────────────────────────────────────────────────────────────

/** Maps a Spotify playlists page response to an array of SpotifyPlaylist. */
export function parseSpotifyPlaylists(data: SpotifyPlaylistsPage): SpotifyPlaylist[] {
  return data.items.map((item) => ({
    id: item.id,
    name: item.name,
    trackCount: item.tracks.total,
  }));
}

/**
 * Maps a Spotify tracks page response to an array of SpotifyTrack.
 * Items where `track` is null (e.g. local files) are skipped.
 */
export function parseSpotifyTracks(data: SpotifyTracksPage): SpotifyTrack[] {
  return data.items
    .filter((item): item is { track: NonNullable<typeof item.track> } => item.track !== null)
    .map((item) => ({
      title: item.track.name,
      artist: item.track.artists[0]?.name ?? 'Unknown',
      durationMs: item.track.duration_ms,
    }));
}

// ─── API functions ────────────────────────────────────────────────────────────

/** Fetches all playlists for the authenticated user, paginating through results. */
export async function fetchPlaylists(accessToken: string): Promise<SpotifyPlaylist[]> {
  const results: SpotifyPlaylist[] = [];
  let url: string | null = `${SPOTIFY_API_BASE}/v1/me/playlists?limit=50`;

  while (url !== null) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Spotify API error ${response.status}: ${await response.text()}`);
    }
    const page = (await response.json()) as SpotifyPlaylistsPage;
    results.push(...parseSpotifyPlaylists(page));
    url = page.next;
  }

  return results;
}

/** Fetches all tracks for a given playlist, paginating through results. */
export async function fetchPlaylistTracks(
  accessToken: string,
  playlistId: string,
): Promise<SpotifyTrack[]> {
  const results: SpotifyTrack[] = [];
  let url: string | null =
    `${SPOTIFY_API_BASE}/v1/playlists/${playlistId}/tracks?limit=100&fields=items(track(name,artists,duration_ms)),next`;

  while (url !== null) {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Spotify API error ${response.status}: ${await response.text()}`);
    }
    const page = (await response.json()) as SpotifyTracksPage;
    results.push(...parseSpotifyTracks(page));
    url = page.next;
  }

  return results;
}

/** Refreshes an expired access token using the stored refresh token. */
export async function refreshAccessToken(
  token: SpotifyToken,
  clientId: string,
  path: string = DEFAULT_TOKEN_PATH,
): Promise<SpotifyToken> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
    client_id: clientId,
  });

  const response = await fetch(`${SPOTIFY_AUTH_BASE}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  const updated: SpotifyToken = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? token.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };

  saveToken(updated, path);
  return updated;
}

/**
 * Loads the stored token, refreshing it if it expires within 60 seconds.
 * Returns null if no token is stored.
 */
export async function getValidToken(
  clientId: string,
  path: string = DEFAULT_TOKEN_PATH,
): Promise<SpotifyToken | null> {
  const token = loadToken(path);
  if (token === null) return null;

  const expiresInMs = token.expires_at - Date.now();
  if (expiresInMs < 60_000) {
    return refreshAccessToken(token, clientId, path);
  }

  return token;
}

/**
 * Runs the full OAuth PKCE flow:
 * 1. Generates a PKCE verifier + challenge and a random state value.
 * 2. Opens the Spotify authorization URL in the browser.
 * 3. Starts a local HTTP server on port 8888 to receive the callback.
 * 4. Exchanges the authorization code for tokens.
 * 5. Saves the token to disk and returns it.
 */
export async function startOAuthFlow(opts: OAuthFlowOptions): Promise<SpotifyToken> {
  const { clientId, tokenPath = DEFAULT_TOKEN_PATH, onUrl } = opts;

  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const state = randomBytes(16).toString('hex');
  const authUrl = buildAuthUrl(challenge, state, clientId);

  // Notify caller of URL (useful for testing or non-macOS environments)
  onUrl?.(authUrl);

  // Open browser
  const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  execFile(openCmd, [authUrl]);

  // Wait for the OAuth callback
  const token = await new Promise<SpotifyToken>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url ?? '/', `http://localhost:8888`);
        if (reqUrl.pathname !== '/callback') {
          res.writeHead(404);
          res.end('Not found');
          return;
        }

        const returnedState = reqUrl.searchParams.get('state');
        const code = reqUrl.searchParams.get('code');
        const error = reqUrl.searchParams.get('error');

        if (error !== null) {
          res.writeHead(400);
          res.end(`Authorization error: ${error}`);
          server.close();
          reject(new Error(`Spotify auth error: ${error}`));
          return;
        }

        if (returnedState !== state) {
          res.writeHead(400);
          res.end('State mismatch');
          server.close();
          reject(new Error('OAuth state mismatch'));
          return;
        }

        if (code === null) {
          res.writeHead(400);
          res.end('Missing code');
          server.close();
          reject(new Error('No authorization code received'));
          return;
        }

        // Exchange code for token
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          client_id: clientId,
          code_verifier: verifier,
        });

        const tokenResponse = await fetch(`${SPOTIFY_AUTH_BASE}/api/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });

        if (!tokenResponse.ok) {
          const text = await tokenResponse.text();
          res.writeHead(500);
          res.end('Token exchange failed');
          server.close();
          reject(new Error(`Token exchange failed ${tokenResponse.status}: ${text}`));
          return;
        }

        const data = (await tokenResponse.json()) as {
          access_token: string;
          refresh_token: string;
          expires_in: number;
        };

        const newToken: SpotifyToken = {
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: Date.now() + data.expires_in * 1000,
        };

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>aux: Spotify connected! You can close this tab.</h2></body></html>');
        server.close();
        resolve(newToken);
      } catch (err) {
        res.writeHead(500);
        res.end('Internal error');
        server.close();
        reject(err);
      }
    });

    server.listen(8888, 'localhost');

    server.on('error', reject);
  });

  saveToken(token, tokenPath);
  return token;
}
