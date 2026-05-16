import { connect } from 'node:net';
import { IPC_PATH } from './constants.js';

export interface IpcClientHandle {
  send(msg: object): void;
  close(): void;
}

export function createIpcClient(opts: {
  onMessage(msg: object): void;
  onEnd?(): void;
  onError?(err: Error): void;
}): IpcClientHandle {
  let buffer = '';
  const socket = connect(IPC_PATH);

  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        opts.onMessage(JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    }
  });

  socket.on('end', () => opts.onEnd?.());
  socket.on('error', (err) => opts.onError?.(err));

  return {
    send: (msg) => { socket.write(JSON.stringify(msg) + '\n'); },
    close: () => { socket.destroy(); },
  };
}
