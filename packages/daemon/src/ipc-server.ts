import { createServer, type Server, type Socket } from 'node:net';
import { rmSync, existsSync } from 'node:fs';

export const IPC_PATH = '/tmp/aux.sock';

export interface IpcServerOptions {
  onConnection?: (socket: Socket) => void;
}

export function createIpcServer({ onConnection }: IpcServerOptions = {}): Server {
  if (existsSync(IPC_PATH)) rmSync(IPC_PATH);

  const server = createServer((socket) => {
    console.log('[daemon] TUI client connected');
    onConnection?.(socket);

    socket.on('data', (raw) => {
      for (const line of raw.toString().split('\n').filter(Boolean)) {
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          socket.emit('message', msg);
        } catch {
          // ignore malformed lines
        }
      }
    });

    socket.on('end', () => console.log('[daemon] TUI client disconnected'));
    socket.on('error', (err) => console.error('[daemon] IPC socket error:', err.message));
  });

  server.listen(IPC_PATH, () => console.log(`[daemon] IPC socket at ${IPC_PATH}`));
  return server;
}
