import type { Room } from './types.js';

export interface VoteResult {
  triggered: boolean;
  votes: number;
  total: number;
}

export function registerVote(room: Room, userId: string): VoteResult {
  if (!room.skipVotes.includes(userId)) {
    room.skipVotes.push(userId);
  }
  const votes = room.skipVotes.length;
  const total = room.members.length;
  const triggered = votes > total / 2;
  if (triggered) {
    room.skipVotes = [];
  }
  return { triggered, votes, total };
}
