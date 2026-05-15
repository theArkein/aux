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

export interface AuthenticatedWs {
  userId?: string;
  username?: string;
}
