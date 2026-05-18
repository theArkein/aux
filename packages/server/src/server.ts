import 'dotenv/config';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { initDb, closeDb } from './db.js';
import { handleMessage, handleDisconnect, type IncomingWs } from './ws-handler.js';
import type { Room, PresenceState } from './types.js';
import type Database from 'better-sqlite3';
import type { Server } from 'node:http';

export interface ServerOptions {
  port?: number;
  jwtSecret?: string;
  dbPath?: string;
}

export interface ServerHandle {
  httpServer: Server;
  wss: WebSocketServer;
  db: Database.Database;
  rooms: Map<string, Room>;
  presence: Map<string, PresenceState>;
}

export async function startServer(opts: ServerOptions = {}): Promise<ServerHandle> {
  const port = opts.port ?? Number(process.env['PORT'] ?? 7700);
  const jwtSecret = opts.jwtSecret ?? process.env['JWT_SECRET'];
  const dbPath = opts.dbPath ?? process.env['DATABASE_PATH'] ?? './aux.db';

  if (!jwtSecret) throw new Error('JWT_SECRET is required');

  const db = initDb(dbPath);
  const rooms = new Map<string, Room>();
  const presence = new Map<string, PresenceState>();
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    const typedWs = ws as IncomingWs;
    typedWs.on('message', (raw) =>
      handleMessage(db, jwtSecret, typedWs, raw.toString(), rooms, wss, presence)
    );
    typedWs.on('error', (err) => console.error('ws error:', err.message));
    typedWs.on('close', () => handleDisconnect(db, rooms, wss, typedWs, presence));
  });

  await new Promise<void>((resolve) => httpServer.listen(port, '0.0.0.0', resolve));
  console.log(`aux-server listening on :${port}`);

  return { httpServer, wss, db, rooms, presence };
}

export async function stopServer({ httpServer, wss, db }: ServerHandle): Promise<void> {
  // Terminate active connections first so their close handlers fire (and use the DB)
  // before we shut the database down.
  const closeEvents = [...wss.clients].map(
    (client) => new Promise<void>((resolve) => { client.once('close', resolve); client.terminate(); })
  );
  await Promise.all(closeEvents);
  wss.close();
  closeDb(db);
  await new Promise<void>((resolve, reject) =>
    httpServer.close((err) => (err ? reject(err) : resolve()))
  );
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  startServer().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
