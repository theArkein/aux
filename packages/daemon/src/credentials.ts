import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface Credentials {
  token: string;
  username: string;
}

interface CredentialsOptions {
  dir?: string;
}

const DEFAULT_DIR = join(homedir(), '.aux');

function credPath(dir?: string): string {
  return join(dir ?? DEFAULT_DIR, 'credentials.json');
}

export function saveCredentials({ token, username, dir }: Credentials & CredentialsOptions): void {
  const dirPath = dir ?? DEFAULT_DIR;
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(credPath(dirPath), JSON.stringify({ token, username }), 'utf8');
}

export function loadCredentials({ dir }: CredentialsOptions = {}): Credentials | null {
  const path = credPath(dir ?? DEFAULT_DIR);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Credentials;
  } catch {
    return null;
  }
}

export function clearCredentials({ dir }: CredentialsOptions = {}): void {
  const path = credPath(dir ?? DEFAULT_DIR);
  if (existsSync(path)) rmSync(path);
}
