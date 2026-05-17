import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

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
      const raw = readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, CacheValue>;
      }
      return {};
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
