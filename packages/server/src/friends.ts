import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { User } from './types.js';

export function addFriend(db: Database.Database, userId: string, friendUsername: string): User {
  const friend = db
    .prepare('SELECT id, username FROM users WHERE username = ?')
    .get(friendUsername) as { id: string; username: string } | undefined;
  if (!friend) throw new Error('UNKNOWN_USER');
  if (friend.id === userId) throw new Error('SELF_FRIEND');

  const existing = db
    .prepare('SELECT id FROM friendships WHERE user_id = ? AND friend_id = ?')
    .get(userId, friend.id) as { id: string } | undefined;
  if (existing) throw new Error('ALREADY_FRIENDS');

  db.prepare(
    'INSERT INTO friendships (id, user_id, friend_id, created_at) VALUES (?, ?, ?, ?)'
  ).run(randomUUID(), userId, friend.id, Date.now());

  return { id: friend.id, username: friend.username };
}

export function getFriends(db: Database.Database, userId: string): User[] {
  return db
    .prepare(
      `SELECT u.id, u.username
       FROM friendships f
       JOIN users u ON u.id = f.friend_id
       WHERE f.user_id = ?`
    )
    .all(userId) as User[];
}
