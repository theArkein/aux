import { randomUUID } from 'node:crypto';
import type { Room, Track } from './types.js';

type TrackInput = Omit<Track, 'id'>;

export function addTrack(room: Room, input: TrackInput): Track {
  if (!input.youtubeUrl || !input.title) {
    throw new Error('MISSING_FIELDS');
  }
  const track: Track = { id: randomUUID(), ...input };
  room.queue.push(track);
  return track;
}
