export interface User {
  id: string;
  username: string;
}

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: number;
}

export interface Member {
  id: string;
  username: string;
  isGuest?: boolean;
}

export interface Track {
  id: string;
  youtubeUrl: string;
  title: string;
  artist: string;
  duration: number; // seconds
  queuedBy: string; // userId
}

export interface Room {
  id: string;
  name: string;
  hostId: string;
  members: Member[];
  queue: Track[];
  nowPlaying: Track | null;
  playbackStartedAt: number | null;
  skipVotes: string[];
  createdAt: number;
}
