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
}

export interface Room {
  id: string;
  name: string;
  hostId: string;
  members: Member[];
  createdAt: number;
}
