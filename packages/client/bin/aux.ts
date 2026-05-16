#!/usr/bin/env tsx
import { WebSocket } from 'ws';
import { readFileSync, existsSync } from 'node:fs';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveCredentials, loadCredentials } from '../src/credentials.js';
import { IPC_PATH, PID_FILE } from '../src/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SERVER_URL = process.env['AUX_SERVER_URL'] ?? 'ws://localhost:3000';
const DAEMON_BIN = resolve(__dirname, '../../daemon/bin/auxd.ts');

const [,, command, ...args] = process.argv;

async function main(): Promise<void> {
  if (command === 'register') {
    const [username, password] = args;
    if (!username || !password) {
      console.error('Usage: aux register <username> <password>');
      process.exit(1);
    }
    await authCommand('register', username, password);
    return;
  }

  if (command === 'login') {
    const [username, password] = args;
    if (!username || !password) {
      console.error('Usage: aux login <username> <password>');
      process.exit(1);
    }
    await authCommand('login', username, password);
    return;
  }

  if (command === 'create') {
    const [name] = args;
    if (!name) {
      console.error('Usage: aux create <name>');
      process.exit(1);
    }
    if (!loadCredentials()) {
      console.error('Guests cannot create rooms. Register first: aux register <username> <password>');
      process.exit(1);
    }
    await roomCommand('room:create', { name });
    return;
  }

  if (command === 'join') {
    const [name] = args;
    if (!name) {
      console.error('Usage: aux join <name>');
      process.exit(1);
    }
    if (loadCredentials()) {
      await roomCommand('room:join', { name });
    } else {
      await guestJoinCommand(name);
    }
    return;
  }

  if (command === 'quit') {
    if (!existsSync(PID_FILE)) {
      console.log('Daemon is not running.');
      return;
    }
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    process.kill(pid, 'SIGTERM');
    console.log('Daemon stopped.');
    return;
  }

  if (command !== undefined) {
    console.error(`Unknown command: ${command}`);
    console.error('Available commands: register, login, create, join, quit');
    process.exit(1);
  }

  // No command: start daemon if needed, attach TUI
  await ensureDaemon();
  const { render } = await import('ink');
  const { createElement } = await import('react');
  const { default: App } = await import('../src/App.js');
  const { waitUntilExit } = render(createElement(App));
  await waitUntilExit();
}

async function authCommand(action: 'register' | 'login', username: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL);

    ws.on('open', () => {
      ws.send(JSON.stringify({ event: 'auth', action, username, password }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (msg['event'] === 'auth:ok') {
        saveCredentials({ token: msg['token'] as string, username: msg['username'] as string });
        console.log(`Logged in as ${msg['username'] as string}`);
        ws.close();
        resolve();
      } else if (msg['event'] === 'auth:error') {
        console.error(`Error: ${msg['code'] as string}`);
        ws.close();
        reject(new Error(msg['code'] as string));
      }
    });

    ws.on('error', reject);
  });
}

async function roomCommand(event: 'room:create' | 'room:join', extra: Record<string, string>): Promise<void> {
  const creds = loadCredentials();
  if (!creds) {
    console.error('Not logged in. Run: aux login <username> <password>');
    process.exit(1);
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER_URL);

    ws.on('open', () => {
      ws.send(JSON.stringify({ event: 'auth', action: 'token', token: creds.token }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;

      if (msg['event'] === 'auth:ok') {
        ws.send(JSON.stringify({ event, ...extra }));
        return;
      }

      if (msg['event'] === 'state:sync') {
        const room = msg['room'] as Record<string, unknown>;
        const members = (room['members'] as Array<{ username: string }>)
          .map((m) => m.username)
          .join(', ');
        console.log(`Room: ${room['name'] as string} (members: ${members})`);
        ws.close();
        resolve();
        return;
      }

      if (msg['event'] === 'room:error' || msg['event'] === 'auth:error') {
        console.error(`Error: ${msg['code'] as string}`);
        ws.close();
        reject(new Error(msg['code'] as string));
      }
    });

    ws.on('error', reject);
  });
}

async function guestJoinCommand(name: string): Promise<void> {
  await ensureDaemon();
  return new Promise((resolve, reject) => {
    const socket = connect(IPC_PATH);
    let buf = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('Timed out waiting for room join response'));
    }, 10000);
    function settle(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    }
    socket.once('connect', () => {
      socket.write(JSON.stringify({ event: 'room:join', name }) + '\n');
    });
    socket.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          if (msg['event'] === 'state:sync') {
            const room = msg['room'] as Record<string, unknown>;
            const members = (room['members'] as Array<{ username: string }>)
              .map((m) => m.username)
              .join(', ');
            console.log(`Room: ${room['name'] as string} (members: ${members})`);
            settle(resolve);
          } else if (msg['event'] === 'room:error' || msg['event'] === 'auth:error') {
            const code = msg['code'] as string;
            console.error(`Error: ${code}`);
            settle(() => reject(new Error(code)));
          }
        } catch { /* ignore parse errors */ }
      }
    });
    socket.on('error', (err) => settle(() => reject(err)));
  });
}

function isDaemonRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;
  try {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim());
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ensureDaemon(): Promise<void> {
  if (!isDaemonRunning()) {
    const child = spawn('npx', ['tsx', DAEMON_BIN], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
  }
  await waitForSocket(IPC_PATH, 5000);
}

async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const available = await new Promise<boolean>((resolve) => {
      const s = connect(path);
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    if (available) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Daemon did not open /tmp/aux.sock within 5s — run: aux quit && aux to restart');
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
