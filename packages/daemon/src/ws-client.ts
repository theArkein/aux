import { WebSocket } from 'ws';

const RECONNECT_DELAY_MS = 3000;

export interface WsClientOptions {
  serverUrl: string;
  onMessage?: (msg: Record<string, unknown>, ws: WebSocket) => void;
  onConnected?: (ws: WebSocket) => void;
}

export interface WsClientHandle {
  send(data: object): void;
  stop(): void;
}

export function createWsClient({ serverUrl, onMessage, onConnected }: WsClientOptions): WsClientHandle {
  let ws: WebSocket | null = null;
  let stopped = false;

  function connect(): void {
    ws = new WebSocket(serverUrl);

    ws.on('open', () => {
      console.log('[daemon] connected to server');
      onConnected?.(ws!);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        onMessage?.(msg, ws!);
      } catch {
        // ignore malformed messages
      }
    });

    ws.on('close', () => {
      if (stopped) return;
      console.log(`[daemon] disconnected — retrying in ${RECONNECT_DELAY_MS}ms`);
      setTimeout(connect, RECONNECT_DELAY_MS);
    });

    ws.on('error', (err) => {
      console.error('[daemon] ws error:', err.message);
    });
  }

  connect();

  return {
    send(data: object): void {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    },
    stop(): void {
      stopped = true;
      ws?.close();
    },
  };
}
