import 'dotenv/config';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { initDb, closeDb } from './db.js';
import { handleMessage } from './ws-handler.js';
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
}

export async function startServer(opts: ServerOptions = {}): Promise<ServerHandle> {
  const port = opts.port ?? Number(process.env['PORT'] ?? 3000);
  const jwtSecret = opts.jwtSecret ?? process.env['JWT_SECRET'];
  const dbPath = opts.dbPath ?? process.env['DATABASE_PATH'] ?? './aux.db';

  if (!jwtSecret) throw new Error('JWT_SECRET is required');

  const db = initDb(dbPath);
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => handleMessage(db, jwtSecret, ws, raw.toString()));
    ws.on('error', (err) => console.error('ws error:', err.message));
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  console.log(`aux-server listening on :${port}`);

  return { httpServer, wss, db };
}

export async function stopServer({ httpServer, wss, db }: ServerHandle): Promise<void> {
  wss.close();
  closeDb(db);
  await new Promise<void>((resolve, reject) => httpServer.close((err) => err ? reject(err) : resolve()));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  startServer().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
