#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import type { Socket } from 'node:net';
import { loadCredentials } from '../src/credentials.js';
import { createWsClient, type WsClientHandle } from '../src/ws-client.js';
import { createIpcServer } from '../src/ipc-server.js';
import { searchYoutube } from '../src/youtube-resolver.js';
import { loadCache, cacheKey } from '../src/yt-cache.js';
import {
  getValidToken,
  startOAuthFlow,
  fetchPlaylists,
  fetchPlaylistTracks,
} from '../src/spotify-client.js';
import { computeDelay, spawnTrack, sendMpvCommand, MPV_IPC_PATH, type TrackProcess } from '../src/playback-engine.js';

const PID_FILE = '/tmp/aux.pid';
const SERVER_URL = process.env['AUX_SERVER_URL'] ?? 'ws://localhost:3000';

let currentTrack: TrackProcess | null = null;
let mpvVolume = 60;
const tuiClients = new Set<Socket>();
const ytCache = loadCache();
let isAuthenticated = false;
let pendingRoomJoin: string | null = null;
let latestFriendsList: object | null = null;

function checkDependencies(): void {
  for (const bin of ['yt-dlp', 'mpv']) {
    try {
      execFileSync('which', [bin], { stdio: 'ignore' });
    } catch {
      console.error(`[auxd] missing dependency: ${bin}`);
      console.error('  Install yt-dlp: https://github.com/yt-dlp/yt-dlp#installation');
      console.error('  Install mpv:    https://mpv.io/installation/');
      process.exit(1);
    }
  }
}
checkDependencies();

writeFileSync(PID_FILE, String(process.pid));
process.on('exit', () => rmSync(PID_FILE, { force: true }));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

function broadcast(msg: object): void {
  const line = JSON.stringify(msg) + '\n';
  for (const client of tuiClients) {
    try { client.write(line); } catch { /* client disconnected */ }
  }
}

function replyToSocket(socket: Socket, msg: object): void {
  socket.write(JSON.stringify(msg) + '\n');
}

function startTrack(youtubeUrl: string, startAt: number, ws: WsClientHandle): void {
  if (currentTrack) {
    currentTrack.kill();
    currentTrack = null;
  }
  const delay = computeDelay(startAt, Date.now());
  setTimeout(() => {
    const proc = spawnTrack(youtubeUrl, MPV_IPC_PATH, mpvVolume);
    currentTrack = proc;
    proc.onExit(() => {
      if (currentTrack !== proc) return;
      currentTrack = null;
      ws.send({ event: 'playback:ended' });
    });
  }, delay);
}

async function handleIpcMessage(
  msg: Record<string, unknown>,
  socket: Socket,
  wsClient: WsClientHandle
): Promise<void> {
  if (msg['event'] === 'search') {
    const query = String(msg['query'] ?? '');
    if (!query) {
      replyToSocket(socket, { event: 'search:error', code: 'MISSING_QUERY' });
      return;
    }
    try {
      const results = await searchYoutube(query);
      replyToSocket(socket, { event: 'search:results', results });
    } catch (err) {
      replyToSocket(socket, { event: 'search:error', code: (err as Error).message });
    }
    return;
  }

  if (msg['event'] === 'queue:add') {
    const youtubeUrl = String(msg['youtubeUrl'] ?? '');
    const title = String(msg['title'] ?? '');
    const artist = String(msg['artist'] ?? '');
    const duration = Number(msg['duration'] ?? 0);
    if (!youtubeUrl || !title || !Number.isFinite(duration)) {
      replyToSocket(socket, { event: 'queue:error', code: 'MISSING_FIELDS' });
      return;
    }
    wsClient.send({ event: 'queue:add', youtubeUrl, title, artist, duration });
    return;
  }

  if (msg['event'] === 'volume:up') {
    mpvVolume = Math.min(100, mpvVolume + 5);
    sendMpvCommand(MPV_IPC_PATH, ['set_property', 'volume', mpvVolume]);
    return;
  }

  if (msg['event'] === 'volume:down') {
    mpvVolume = Math.max(0, mpvVolume - 5);
    sendMpvCommand(MPV_IPC_PATH, ['set_property', 'volume', mpvVolume]);
    return;
  }

  if (msg['event'] === 'queue:skip') {
    wsClient.send({ event: 'queue:skip' });
    return;
  }

  if (msg['event'] === 'room:join') {
    const name = String(msg['name'] ?? '');
    if (!name) {
      replyToSocket(socket, { event: 'room:error', code: 'MISSING_FIELDS' });
      return;
    }
    if (isAuthenticated) {
      wsClient.send({ event: 'room:join', name });
    } else {
      pendingRoomJoin = name;
    }
    return;
  }

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

  if (msg['event'] === 'spotify:import') {
    const playlistId = String(msg['playlistId'] ?? '');
    if (!playlistId) {
      replyToSocket(socket, { event: 'spotify:error', code: 'MISSING_PLAYLIST_ID' });
      return;
    }
    const clientId = process.env['SPOTIFY_CLIENT_ID'] ?? '';
    if (!clientId) {
      replyToSocket(socket, {
        event: 'spotify:error',
        code: 'SPOTIFY_CLIENT_ID_NOT_SET',
        message: 'Set SPOTIFY_CLIENT_ID env var. Create an app at https://developer.spotify.com/dashboard',
      });
      return;
    }
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
}

const wsClient = createWsClient({
  serverUrl: SERVER_URL,
  onConnected(ws) {
    isAuthenticated = false;
    const creds = loadCredentials();
    if (creds?.token) {
      ws.send(JSON.stringify({ event: 'auth', action: 'token', token: creds.token }));
    } else {
      ws.send(JSON.stringify({ event: 'auth', action: 'guest' }));
    }
  },
  onMessage(msg) {
    broadcast(msg);

    if (msg['event'] === 'auth:ok') {
      isAuthenticated = true;
      wsClient.send({ event: 'friend:list' });
      if (pendingRoomJoin) {
        wsClient.send({ event: 'room:join', name: pendingRoomJoin });
        pendingRoomJoin = null;
      }
    }

    if (msg['event'] === 'auth:error') {
      pendingRoomJoin = null;
    }

    if (msg['event'] === 'friends:list') {
      latestFriendsList = msg;
    }

    if (msg['event'] === 'playback:next') {
      const track = msg['track'];
      if (typeof track !== 'object' || track === null) return;
      const youtubeUrl = String((track as Record<string, unknown>)['youtubeUrl'] ?? '');
      const startAt = Number(msg['startAt']);
      if (youtubeUrl && Number.isFinite(startAt)) {
        startTrack(youtubeUrl, startAt, wsClient);
      }
    }
  },
});

createIpcServer({
  onConnection(socket) {
    tuiClients.add(socket);
    if (latestFriendsList) {
      socket.write(JSON.stringify(latestFriendsList) + '\n');
    }
    socket.on('end', () => tuiClients.delete(socket));
    socket.on('error', () => tuiClients.delete(socket));
    socket.on('message', (msg: Record<string, unknown>) => {
      handleIpcMessage(msg, socket, wsClient).catch((err: Error) => {
        console.error('[daemon] IPC handler error:', err.message);
      });
    });
  },
});

console.log(`[auxd] running (pid ${process.pid})`);
