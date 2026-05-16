#!/usr/bin/env tsx
import { writeFileSync, rmSync } from 'node:fs';
import type { Socket } from 'node:net';
import { loadCredentials } from '../src/credentials.js';
import { createWsClient, type WsClientHandle } from '../src/ws-client.js';
import { createIpcServer } from '../src/ipc-server.js';
import { searchYoutube } from '../src/youtube-resolver.js';
import { computeDelay, spawnTrack, sendMpvCommand, MPV_IPC_PATH, type TrackProcess } from '../src/playback-engine.js';

const PID_FILE = '/tmp/aux.pid';
const SERVER_URL = process.env['AUX_SERVER_URL'] ?? 'ws://localhost:3000';

let currentTrack: TrackProcess | null = null;
let mpvVolume = 60;
const tuiClients = new Set<Socket>();

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
    const proc = spawnTrack(youtubeUrl);
    currentTrack = proc;
    setTimeout(() => sendMpvCommand(MPV_IPC_PATH, ['set_property', 'volume', mpvVolume]), 500);
    proc.onExit(() => {
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
}

const wsClient = createWsClient({
  serverUrl: SERVER_URL,
  onConnected(ws) {
    const creds = loadCredentials();
    if (creds?.token) {
      ws.send(JSON.stringify({ event: 'auth', action: 'token', token: creds.token }));
    }
  },
  onMessage(msg) {
    broadcast(msg);

    if (msg['event'] === 'playback:next') {
      const track = msg['track'] as Record<string, unknown>;
      const youtubeUrl = String(track['youtubeUrl'] ?? '');
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
