import { spawn } from 'node:child_process';

export interface SearchResult {
  title: string;
  artist: string;
  duration: number;
  youtubeUrl: string;
}

export function parseYtDlpOutput(stdout: string): SearchResult[] {
  const results: SearchResult[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      results.push({
        title: String(entry['title'] ?? 'Unknown'),
        artist: String(entry['uploader'] ?? entry['channel'] ?? 'Unknown'),
        duration: Number(entry['duration'] ?? 0),
        youtubeUrl: String(entry['webpage_url'] ?? ''),
      });
    } catch {
      // skip malformed lines
    }
  }
  return results;
}

export function searchYoutube(query: string, limit = 5): Promise<SearchResult[]> {
  return new Promise((resolve, reject) => {
    const args = [
      `ytsearch${limit}:${query}`,
      '--dump-json',
      '--no-playlist',
      '--quiet',
    ];

    const proc = spawn('yt-dlp', args, { env: process.env });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('YT_DLP_NOT_FOUND'));
      } else {
        reject(err);
      }
    });

    proc.on('close', (code) => {
      if (code !== 0 && !stdout) {
        reject(new Error(`yt-dlp exited with code ${code}: ${stderr.trim()}`));
        return;
      }

      resolve(parseYtDlpOutput(stdout));
    });
  });
}
