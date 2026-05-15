import Database from 'better-sqlite3';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    username     TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;

export function initDb(path: string): Database.Database {
  const db = new Database(path);
  db.exec(SCHEMA);
  return db;
}

export function closeDb(db: Database.Database): void {
  db.close();
}
