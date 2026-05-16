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
  const proc = spawn(
    'sh',
    ['-c', `yt-dlp -f bestaudio -q -o - '${youtubeUrl}' | mpv --no-terminal --idle=no --input-ipc-server=${ipcPath} -`],
    { stdio: 'ignore' }
  );
  return {
    kill() { proc.kill('SIGTERM'); },
    onExit(cb) { proc.on('exit', cb); },
  };
}

export function sendMpvCommand(ipcPath: string, command: unknown[]): void {
  const sock = createConnection(ipcPath);
  sock.on('connect', () => {
    sock.write(JSON.stringify({ command }) + '\n');
    sock.end();
  });
  sock.on('error', () => { /* mpv may not be ready — silently ignore */ });
}
