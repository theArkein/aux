import { randomUUID } from 'node:crypto';
import type { Room, Member } from './types.js';

const ROOM_NAME_RE = /^[a-z0-9]{3,20}$/;

export function validateRoomName(name: string): void {
  if (!ROOM_NAME_RE.test(name)) {
    throw new Error('INVALID_ROOM_NAME');
  }
}

export function createRoom(rooms: Map<string, Room>, name: string, host: Member): Room {
  validateRoomName(name);
  for (const room of rooms.values()) {
    if (room.name === name) throw new Error('ROOM_NAME_TAKEN');
  }
  const room: Room = {
    id: randomUUID(),
    name,
    hostId: host.id,
    members: [{ id: host.id, username: host.username }],
    queue: [],
    createdAt: Date.now(),
  };
  rooms.set(room.id, room);
  return room;
}

export function joinRoom(rooms: Map<string, Room>, roomName: string, member: Member): Room {
  const room = getRoomByName(rooms, roomName);
  if (!room) throw new Error('ROOM_NOT_FOUND');
  if (!room.members.some((m) => m.id === member.id)) {
    room.members.push({ id: member.id, username: member.username });
  }
  return room;
}

export function leaveRoom(rooms: Map<string, Room>, roomId: string, userId: string): Room | null {
  const room = rooms.get(roomId);
  if (!room) return null;
  room.members = room.members.filter((m) => m.id !== userId);
  if (room.members.length === 0) {
    rooms.delete(roomId);
    return null;
  }
  if (room.hostId === userId) {
    room.hostId = room.members[0]!.id;
  }
  return room;
}

export function getRoomByName(rooms: Map<string, Room>, name: string): Room | undefined {
  for (const room of rooms.values()) {
    if (room.name === name) return room;
  }
  return undefined;
}

export function getRoom(rooms: Map<string, Room>, id: string): Room | undefined {
  return rooms.get(id);
}
