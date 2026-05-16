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

export function spawnTrack(youtubeUrl: string, ipcPath = MPV_IPC_PATH): TrackProcess {
  const ytdlp = spawn('yt-dlp', ['-f', 'bestaudio', '-q', '-o', '-', youtubeUrl], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const mpv = spawn('mpv', ['--no-terminal', '--idle=no', `--input-ipc-server=${ipcPath}`, '-'], {
    stdio: [ytdlp.stdout, 'ignore', 'ignore'],
  });
  ytdlp.on('error', (err) => console.error('[daemon] yt-dlp error:', err.message));
  mpv.on('error', (err) => console.error('[daemon] mpv error:', err.message));
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
