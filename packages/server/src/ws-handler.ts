import type Database from 'better-sqlite3';
import { WebSocket, type WebSocketServer } from 'ws';
import { registerUser, loginUser, signToken, verifyToken, createGuestSession } from './auth.js';
import { createRoom, joinRoom, leaveRoom } from './rooms.js';
import { addTrack } from './queue.js';
import { registerVote } from './skip.js';
import { startPlayback, endPlayback } from './playback.js';
import { addFriend, getFriends, getFollowers } from './friends.js';
import type { User, Room, PresenceState, FriendPresence } from './types.js';

export interface IncomingWs extends WebSocket {
  userId?: string;
  username?: string;
  roomId?: string;
  isGuest?: boolean;
}

interface AuthMessage {
  event: 'auth';
  action: 'register' | 'login' | 'token' | 'guest';
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

interface QueueSkipMessage {
  event: 'queue:skip';
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

function buildFriendList(
  db: Database.Database,
  userId: string,
  presence: Map<string, PresenceState>,
  rooms: Map<string, Room>
): FriendPresence[] {
  const friends = getFriends(db, userId);
  return friends.map((f) => {
    const p = presence.get(f.id);
    const status = p?.status ?? 'offline';
    const roomId = p?.roomId ?? null;
    const room = roomId ? rooms.get(roomId) : null;
    return { id: f.id, username: f.username, status, roomName: room?.name ?? null };
  });
}

function broadcastFriendsListToWatchers(
  db: Database.Database,
  wss: WebSocketServer,
  userId: string,
  presence: Map<string, PresenceState>,
  rooms: Map<string, Room>
): void {
  const watchers = getFollowers(db, userId);
  const watcherIds = new Set(watchers.map((w) => w.user_id));
  for (const client of wss.clients) {
    const c = client as IncomingWs;
    if (c.userId && watcherIds.has(c.userId) && c.readyState === WebSocket.OPEN) {
      reply(c, {
        event: 'friends:list',
        friends: buildFriendList(db, c.userId, presence, rooms),
      });
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
    } else if (msg.action === 'guest') {
      const guest = createGuestSession();
      ws.userId = guest.id;
      ws.username = guest.username;
      ws.isGuest = true;
      reply(ws, { event: 'auth:ok', username: guest.username });
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
  if (ws.isGuest) {
    reply(ws, { event: 'room:error', code: 'GUESTS_CANNOT_CREATE_ROOMS' });
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
    const room = joinRoom(rooms, msg.name, { id: ws.userId, username: ws.username, isGuest: ws.isGuest });
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
    const nextTrack = startPlayback(room);
    broadcastToRoom(wss, room, { event: 'queue:update', queue: room.queue });
    if (nextTrack) {
      const startAt = Date.now() + 200;
      broadcastToRoom(wss, room, { event: 'playback:next', track: nextTrack, startAt });
    }
  } catch (err) {
    reply(ws, { event: 'queue:error', code: (err as Error).message });
  }
}

function handlePlaybackEnded(
  rooms: Map<string, Room>,
  wss: WebSocketServer,
  ws: IncomingWs
): void {
  if (!ws.userId || !ws.roomId) {
    reply(ws, { event: 'playback:error', code: 'NOT_IN_ROOM' });
    return;
  }
  const room = rooms.get(ws.roomId);
  if (!room) return;

  const nextTrack = endPlayback(room);
  broadcastToRoom(wss, room, { event: 'state:sync', room });

  if (nextTrack) {
    const startAt = Date.now() + 200;
    broadcastToRoom(wss, room, { event: 'playback:next', track: nextTrack, startAt });
  }
}

function handleQueueSkip(
  rooms: Map<string, Room>,
  wss: WebSocketServer,
  ws: IncomingWs
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
  if (!room.nowPlaying) {
    reply(ws, { event: 'queue:error', code: 'NOTHING_PLAYING' });
    return;
  }

  if (ws.userId === room.hostId) {
    room.skipVotes = [];
    const nextTrack = endPlayback(room);
    broadcastToRoom(wss, room, { event: 'state:sync', room });
    if (nextTrack) {
      const startAt = Date.now() + 200;
      broadcastToRoom(wss, room, { event: 'playback:next', track: nextTrack, startAt });
    }
  } else {
    const result = registerVote(room, ws.userId);
    if (result.triggered) {
      const nextTrack = endPlayback(room);
      broadcastToRoom(wss, room, { event: 'state:sync', room });
      if (nextTrack) {
        const startAt = Date.now() + 200;
        broadcastToRoom(wss, room, { event: 'playback:next', track: nextTrack, startAt });
      }
    } else {
      broadcastToRoom(wss, room, { event: 'state:sync', room });
    }
  }
}

function handleFriendAdd(
  db: Database.Database,
  ws: IncomingWs,
  username: string,
  presence: Map<string, PresenceState>,
  rooms: Map<string, Room>
): void {
  if (!ws.userId || ws.isGuest) {
    reply(ws, { event: 'friend:error', code: 'NOT_AUTHENTICATED' });
    return;
  }
  try {
    addFriend(db, ws.userId, username);
    reply(ws, { event: 'friends:list', friends: buildFriendList(db, ws.userId, presence, rooms) });
  } catch (err) {
    reply(ws, { event: 'friend:error', code: (err as Error).message });
  }
}

function handleFriendList(
  db: Database.Database,
  ws: IncomingWs,
  presence: Map<string, PresenceState>,
  rooms: Map<string, Room>
): void {
  if (!ws.userId || ws.isGuest) {
    reply(ws, { event: 'friend:error', code: 'NOT_AUTHENTICATED' });
    return;
  }
  reply(ws, { event: 'friends:list', friends: buildFriendList(db, ws.userId, presence, rooms) });
}

export function handleDisconnect(
  db: Database.Database,
  rooms: Map<string, Room>,
  wss: WebSocketServer,
  ws: IncomingWs,
  presence: Map<string, PresenceState>
): void {
  if (ws.roomId && ws.userId) {
    const updated = leaveRoom(rooms, ws.roomId, ws.userId);
    ws.roomId = undefined;
    if (updated) {
      broadcastToRoom(wss, updated, { event: 'state:sync', room: updated });
    }
  }
  if (ws.userId) {
    presence.set(ws.userId, { status: 'offline', roomId: null });
    broadcastFriendsListToWatchers(db, wss, ws.userId, presence, rooms);
    if (ws.isGuest) presence.delete(ws.userId);
  }
}

export function handleMessage(
  db: Database.Database,
  jwtSecret: string,
  ws: IncomingWs,
  raw: string,
  rooms: Map<string, Room>,
  wss: WebSocketServer,
  presence: Map<string, PresenceState>
): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    reply(ws, { event: 'error', code: 'BAD_JSON' });
    return;
  }

  if (msg['event'] === 'auth') {
    const prevUserId = ws.userId;
    handleAuth(db, jwtSecret, ws, msg as unknown as AuthMessage);
    if (ws.userId && ws.userId !== prevUserId) {
      presence.set(ws.userId, { status: 'online', roomId: null });
      broadcastFriendsListToWatchers(db, wss, ws.userId, presence, rooms);
    }
    return;
  }

  if (msg['event'] === 'room:create') {
    if (typeof msg['name'] !== 'string') {
      reply(ws, { event: 'room:error', code: 'MISSING_FIELDS' });
      return;
    }
    handleRoomCreate(rooms, ws, msg as unknown as RoomCreateMessage);
    if (ws.userId && ws.roomId) {
      presence.set(ws.userId, { status: 'online', roomId: ws.roomId });
      broadcastFriendsListToWatchers(db, wss, ws.userId, presence, rooms);
    }
    return;
  }

  if (msg['event'] === 'room:join') {
    if (typeof msg['name'] !== 'string') {
      reply(ws, { event: 'room:error', code: 'MISSING_FIELDS' });
      return;
    }
    handleRoomJoin(rooms, wss, ws, msg as unknown as RoomJoinMessage);
    if (ws.userId && ws.roomId) {
      presence.set(ws.userId, { status: 'online', roomId: ws.roomId });
      broadcastFriendsListToWatchers(db, wss, ws.userId, presence, rooms);
    }
    return;
  }

  if (msg['event'] === 'room:leave') {
    const prevRoomId = ws.roomId;
    handleRoomLeave(rooms, wss, ws);
    if (ws.userId && prevRoomId && !ws.roomId) {
      presence.set(ws.userId, { status: 'online', roomId: null });
      broadcastFriendsListToWatchers(db, wss, ws.userId, presence, rooms);
    }
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

  if (msg['event'] === 'playback:ended') {
    handlePlaybackEnded(rooms, wss, ws);
    return;
  }

  if (msg['event'] === 'queue:skip') {
    handleQueueSkip(rooms, wss, ws);
    return;
  }

  if (msg['event'] === 'friend:add') {
    if (typeof msg['username'] !== 'string' || !msg['username']) {
      reply(ws, { event: 'friend:error', code: 'MISSING_FIELDS' });
      return;
    }
    handleFriendAdd(db, ws, msg['username'] as string, presence, rooms);
    return;
  }

  if (msg['event'] === 'friend:list') {
    handleFriendList(db, ws, presence, rooms);
    return;
  }

  reply(ws, { event: 'error', code: 'UNKNOWN_EVENT' });
}
