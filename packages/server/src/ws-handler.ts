import type Database from 'better-sqlite3';
import { WebSocket, type WebSocketServer } from 'ws';
import { registerUser, loginUser, signToken, verifyToken } from './auth.js';
import { createRoom, joinRoom, leaveRoom } from './rooms.js';
import { addTrack } from './queue.js';
import type { User, Room } from './types.js';

export interface IncomingWs extends WebSocket {
  userId?: string;
  username?: string;
  roomId?: string;
}

interface AuthMessage {
  event: 'auth';
  action: 'register' | 'login' | 'token';
  username?: string;
  password?: string;
  token?: string;
}

interface RoomCreateMessage {
  event: 'room:create';
  name: string;
}

interface RoomJoinMessage {
  event: 'room:join';
  name: string;
}

interface RoomLeaveMessage {
  event: 'room:leave';
}

interface QueueAddMessage {
  event: 'queue:add';
  youtubeUrl: string;
  title: string;
  artist: string;
  duration: number;
}

function reply(ws: WebSocket, data: object): void {
  ws.send(JSON.stringify(data));
}

function broadcastToRoom(wss: WebSocketServer, room: Room, data: object): void {
  const memberIds = new Set(room.members.map((m) => m.id));
  for (const client of wss.clients) {
    const c = client as IncomingWs;
    if (c.userId && memberIds.has(c.userId) && c.readyState === WebSocket.OPEN) {
      c.send(JSON.stringify(data));
    }
  }
}

function handleAuth(
  db: Database.Database,
  jwtSecret: string,
  ws: IncomingWs,
  msg: AuthMessage
): void {
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

function handleRoomCreate(
  rooms: Map<string, Room>,
  ws: IncomingWs,
  msg: RoomCreateMessage
): void {
  if (!ws.userId || !ws.username) {
    reply(ws, { event: 'room:error', code: 'UNAUTHENTICATED' });
    return;
  }
  try {
    const room = createRoom(rooms, msg.name, { id: ws.userId, username: ws.username });
    ws.roomId = room.id;
    reply(ws, { event: 'state:sync', room });
  } catch (err) {
    reply(ws, { event: 'room:error', code: (err as Error).message });
  }
}

function handleRoomJoin(
  rooms: Map<string, Room>,
  wss: WebSocketServer,
  ws: IncomingWs,
  msg: RoomJoinMessage
): void {
  if (!ws.userId || !ws.username) {
    reply(ws, { event: 'room:error', code: 'UNAUTHENTICATED' });
    return;
  }
  try {
    const room = joinRoom(rooms, msg.name, { id: ws.userId, username: ws.username });
    ws.roomId = room.id;
    broadcastToRoom(wss, room, { event: 'state:sync', room });
  } catch (err) {
    reply(ws, { event: 'room:error', code: (err as Error).message });
  }
}

function handleRoomLeave(
  rooms: Map<string, Room>,
  wss: WebSocketServer,
  ws: IncomingWs
): void {
  if (!ws.userId || !ws.roomId) {
    reply(ws, { event: 'room:error', code: 'NOT_IN_ROOM' });
    return;
  }
  const updated = leaveRoom(rooms, ws.roomId, ws.userId);
  ws.roomId = undefined;
  reply(ws, { event: 'room:left' });
  if (updated) {
    broadcastToRoom(wss, updated, { event: 'state:sync', room: updated });
  }
}

function handleQueueAdd(
  rooms: Map<string, Room>,
  wss: WebSocketServer,
  ws: IncomingWs,
  msg: QueueAddMessage
): void {
  if (!ws.userId || !ws.roomId) {
    reply(ws, { event: 'queue:error', code: 'NOT_IN_ROOM' });
    return;
  }
  const room = rooms.get(ws.roomId);
  if (!room) {
    reply(ws, { event: 'queue:error', code: 'ROOM_NOT_FOUND' });
    return;
  }
  try {
    addTrack(room, {
      youtubeUrl: msg.youtubeUrl,
      title: msg.title,
      artist: msg.artist,
      duration: msg.duration,
      queuedBy: ws.userId,
    });
    broadcastToRoom(wss, room, { event: 'queue:update', queue: room.queue });
  } catch (err) {
    reply(ws, { event: 'queue:error', code: (err as Error).message });
  }
}

export function handleDisconnect(
  rooms: Map<string, Room>,
  wss: WebSocketServer,
  ws: IncomingWs
): void {
  if (ws.roomId && ws.userId) {
    const updated = leaveRoom(rooms, ws.roomId, ws.userId);
    ws.roomId = undefined;
    if (updated) {
      broadcastToRoom(wss, updated, { event: 'state:sync', room: updated });
    }
  }
}

export function handleMessage(
  db: Database.Database,
  jwtSecret: string,
  ws: IncomingWs,
  raw: string,
  rooms: Map<string, Room>,
  wss: WebSocketServer
): void {
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

  if (msg['event'] === 'room:create') {
    if (typeof msg['name'] !== 'string') {
      reply(ws, { event: 'room:error', code: 'MISSING_FIELDS' });
      return;
    }
    handleRoomCreate(rooms, ws, msg as unknown as RoomCreateMessage);
    return;
  }

  if (msg['event'] === 'room:join') {
    if (typeof msg['name'] !== 'string') {
      reply(ws, { event: 'room:error', code: 'MISSING_FIELDS' });
      return;
    }
    handleRoomJoin(rooms, wss, ws, msg as unknown as RoomJoinMessage);
    return;
  }

  if (msg['event'] === 'room:leave') {
    handleRoomLeave(rooms, wss, ws);
    return;
  }

  if (msg['event'] === 'queue:add') {
    if (
      typeof msg['youtubeUrl'] !== 'string' ||
      typeof msg['title'] !== 'string' ||
      typeof msg['artist'] !== 'string' ||
      typeof msg['duration'] !== 'number'
    ) {
      reply(ws, { event: 'queue:error', code: 'MISSING_FIELDS' });
      return;
    }
    handleQueueAdd(rooms, wss, ws, msg as unknown as QueueAddMessage);
    return;
  }

  reply(ws, { event: 'error', code: 'UNKNOWN_EVENT' });
}
