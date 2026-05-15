#!/usr/bin/env tsx
import { writeFileSync, rmSync } from 'node:fs';
import type { Socket } from 'node:net';
import { loadCredentials } from '../src/credentials.js';
import { createWsClient } from '../src/ws-client.js';
import { createIpcServer } from '../src/ipc-server.js';

const PID_FILE = '/tmp/aux.pid';
const SERVER_URL = process.env['AUX_SERVER_URL'] ?? 'ws://localhost:3000';

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

createIpcServer({
  onConnection(socket) {
    tuiClients.add(socket);
    socket.on('end', () => tuiClients.delete(socket));
    socket.on('error', () => tuiClients.delete(socket));
  },
});

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
  },
});

console.log(`[auxd] running (pid ${process.pid})`);
