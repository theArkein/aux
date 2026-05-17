import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export type CacheValue = string | null;

export interface YtCache {
  get(key: string): CacheValue | undefined;
  set(key: string, value: CacheValue): void;
}

export function cacheKey(title: string, artist: string): string {
  return `${title} ${artist}`.toLowerCase();
}

export function loadCache(path?: string): YtCache {
  const filePath = path ?? join(homedir(), '.aux', 'yt-cache.json');

  const readData = (): Record<string, CacheValue> => {
    if (!existsSync(filePath)) {
      return {};
    }
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return {};
      }
      const data: Record<string, CacheValue> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === 'string' || v === null) data[k] = v;
      }
      return data;
    } catch {
      return {};
    }
  };

  const writeData = (data: Record<string, CacheValue>): void => {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  };

  let data = readData();

  return {
    get(key: string): CacheValue | undefined {
      return Object.prototype.hasOwnProperty.call(data, key)
        ? data[key]
        : undefined;
    },
    set(key: string, value: CacheValue): void {
      data[key] = value;
      writeData(data);
    },
  };
}
