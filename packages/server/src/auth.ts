import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type Database from 'better-sqlite3';
import type { User, UserRow } from './types.js';

const SALT_ROUNDS = 10;

export function registerUser(db: Database.Database, username: string, password: string): User {
  const existing = db.prepare<[string], Pick<UserRow, 'id'>>('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) throw new Error('USERNAME_TAKEN');

  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
  const id = randomUUID();

  db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)').run(id, username, passwordHash);

  return { id, username };
}

export function loginUser(db: Database.Database, username: string, password: string): User {
  const row = db.prepare<[string], UserRow>('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
  if (!row) throw new Error('INVALID_CREDENTIALS');

  const match = bcrypt.compareSync(password, row.password_hash);
  if (!match) throw new Error('INVALID_CREDENTIALS');

  return { id: row.id, username: row.username };
}

export function signToken(payload: User, secret: string): string {
  return jwt.sign(payload, secret, { expiresIn: '30d' });
}

export function verifyToken(token: string, secret: string): User {
  return jwt.verify(token, secret) as User;
}
