import type { Room, Track } from './types.js';

export function startPlayback(room: Room): Track | null {
  if (room.nowPlaying !== null) return null;
  if (room.queue.length === 0) return null;
  const track = room.queue.shift()!;
  room.nowPlaying = track;
  room.playbackStartedAt = Date.now();
  return track;
}

export function endPlayback(room: Room): Track | null {
  if (room.queue.length > 0) {
    const next = room.queue.shift()!;
    room.nowPlaying = next;
    room.playbackStartedAt = Date.now();
    return next;
  }
  room.nowPlaying = null;
  room.playbackStartedAt = null;
  return null;
}
