import type Database from 'better-sqlite3';
import type WebSocket from 'ws';
import { registerUser, loginUser, signToken, verifyToken } from './auth.js';
import type { User } from './types.js';

interface IncomingWs extends WebSocket {
  userId?: string;
  username?: string;
}

interface AuthMessage {
  event: 'auth';
  action: 'register' | 'login' | 'token';
  username?: string;
  password?: string;
  token?: string;
}

function reply(ws: WebSocket, data: object): void {
  ws.send(JSON.stringify(data));
}

function handleAuth(db: Database.Database, jwtSecret: string, ws: IncomingWs, msg: AuthMessage): void {
  try {
    let user: User;

    if (msg.action === 'register') {
      if (!msg.username || !msg.password) {
        reply(ws, { event: 'auth:error', code: 'MISSING_FIELDS' });
        return;
      }
      user = registerUser(db, msg.username, msg.password);
    } else if (msg.action === 'login') {
      if (!msg.username || !msg.password) {
        reply(ws, { event: 'auth:error', code: 'MISSING_FIELDS' });
        return;
      }
      user = loginUser(db, msg.username, msg.password);
    } else if (msg.action === 'token') {
      if (!msg.token) {
        reply(ws, { event: 'auth:error', code: 'MISSING_FIELDS' });
        return;
      }
      user = verifyToken(msg.token, jwtSecret);
      ws.userId = user.id;
      ws.username = user.username;
      reply(ws, { event: 'auth:ok', username: user.username });
      return;
    } else {
      reply(ws, { event: 'auth:error', code: 'UNKNOWN_ACTION' });
      return;
    }

    const token = signToken(user, jwtSecret);
    ws.userId = user.id;
    ws.username = user.username;
    reply(ws, { event: 'auth:ok', token, username: user.username });
  } catch (err) {
    reply(ws, { event: 'auth:error', code: (err as Error).message });
  }
}

export function handleMessage(db: Database.Database, jwtSecret: string, ws: IncomingWs, raw: string): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    reply(ws, { event: 'error', code: 'BAD_JSON' });
    return;
  }

  if (msg['event'] === 'auth') {
    handleAuth(db, jwtSecret, ws, msg as unknown as AuthMessage);
    return;
  }

  reply(ws, { event: 'error', code: 'UNKNOWN_EVENT' });
}
