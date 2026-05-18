import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';

export const MPV_IPC_PATH = '/tmp/auxmpv.sock';

export function computeDelay(startAt: number, now: number): number {
  return Math.max(0, startAt - now);
}

export interface TrackProcess {
  kill(): void;
  onExit(cb: () => void): void;
}

export function spawnTrack(youtubeUrl: string, ipcPath = MPV_IPC_PATH, volume = 60, onError?: (msg: string) => void): TrackProcess {
  const ytdlp = spawn('yt-dlp', ['-f', 'bestaudio', '-q', '-o', '-', youtubeUrl], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const mpv = spawn('mpv', ['--no-terminal', '--idle=no', `--input-ipc-server=${ipcPath}`, `--volume=${volume}`, '-'], {
    stdio: [ytdlp.stdout, 'ignore', 'ignore'],
  });
  let ytdlpStderr = '';
  ytdlp.stderr?.on('data', (d: Buffer) => { ytdlpStderr += d.toString(); });
  ytdlp.on('close', (code) => {
    if (code !== 0 && code !== null) {
      const msg = ytdlpStderr.trim().split('\n').pop() ?? 'yt-dlp failed';
      console.error('[daemon] yt-dlp exit', code, msg);
      onError?.(msg);
    }
  });
  ytdlp.on('error', (err) => { console.error('[daemon] yt-dlp error:', err.message); onError?.(err.message); });
  mpv.on('error', (err) => { console.error('[daemon] mpv error:', err.message); onError?.(err.message); });
  return {
    kill() { ytdlp.kill('SIGTERM'); mpv.kill('SIGTERM'); },
    onExit(cb) { mpv.on('exit', cb); },
  };
}

export function sendMpvCommand(ipcPath: string, command: (string | number | boolean)[]): void {
  const sock = createConnection(ipcPath);
  sock.on('connect', () => {
    sock.write(JSON.stringify({ command }) + '\n');
    sock.end();
  });
  sock.on('error', () => { /* mpv may not be ready — silently ignore */ });
}
