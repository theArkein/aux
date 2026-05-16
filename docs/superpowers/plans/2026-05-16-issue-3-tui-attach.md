# TUI Client Attaches to Daemon (Detachable) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Running `aux` (no args) starts the daemon if not running, then renders a full-screen Ink TUI with three panels (now-playing, queue, members). Closing the terminal detaches without killing the daemon. `aux` in a new terminal reattaches.

**Architecture:** `aux` checks `/tmp/aux.pid`, spawns `auxd` detached if not running, waits for `/tmp/aux.sock`, then renders an Ink React component. The Ink App connects to the IPC socket and renders daemon broadcasts. The daemon stays alive when the Ink process exits.

**Tech Stack:** TypeScript strict, Ink v5, React 18, `node:net` IPC client, `tsx` dev runner.

---

## File Structure

| File | Action |
|---|---|
| `packages/client/package.json` | Add `ink ^5.0.0`, `react ^18`, `@types/react ^18` |
| `packages/client/tsconfig.json` | Add `"jsx": "react-jsx"` to compilerOptions |
| `packages/client/src/ipc-client.ts` | Create — IPC socket client that reads newline-delimited JSON |
| `packages/client/src/App.tsx` | Create — Ink TUI component with three panels |
| `packages/client/bin/aux.ts` | Update — add default (no command) path: auto-start daemon + attach TUI |

---

### Task 1: Add Ink/React dependencies and tsconfig JSX support

**Files:**
- Modify: `packages/client/package.json`
- Modify: `packages/client/tsconfig.json`

- [ ] **Step 1: Update packages/client/package.json**

```json
{
  "name": "@aux/client",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "aux": "./bin/aux.ts"
  },
  "scripts": {
    "start": "node dist/bin/aux.js",
    "dev": "tsx bin/aux.ts",
    "build": "tsc"
  },
  "dependencies": {
    "ink": "^5.0.0",
    "react": "^18.0.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^18.0.0",
    "@types/ws": "^8.5.13",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Update packages/client/tsconfig.json**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "jsx": "react-jsx"
  },
  "include": ["bin/**/*", "src/**/*"]
}
```

- [ ] **Step 3: Install dependencies**

```bash
npm install --workspace=packages/client
```

- [ ] **Step 4: Commit**

```bash
git add packages/client/package.json packages/client/tsconfig.json
git commit -m "feat(client): add Ink + React deps, enable JSX"
```

---

### Task 2: Create IPC client module

**Files:**
- Create: `packages/client/src/ipc-client.ts`

- [ ] **Step 1: Create the file**

```ts
import { connect } from 'node:net';

const IPC_PATH = '/tmp/aux.sock';

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
```

- [ ] **Step 2: Commit**

```bash
git add packages/client/src/ipc-client.ts
git commit -m "feat(client): IPC client for daemon socket"
```

---

### Task 3: Create Ink TUI App component

**Files:**
- Create: `packages/client/src/App.tsx`

Three panels in a horizontal row: Now Playing, Queue, Members. Tab cycles focus. `q` quits the TUI (daemon keeps running).

- [ ] **Step 1: Create packages/client/src/App.tsx**

```tsx
import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { createIpcClient } from './ipc-client.js';

type PanelId = 'nowPlaying' | 'queue' | 'members';
const PANELS: PanelId[] = ['nowPlaying', 'queue', 'members'];

interface Member {
  id: string;
  username: string;
}

interface QueueTrack {
  id: string;
  title: string;
  queuedBy: string;
}

interface RoomState {
  name: string;
  members: Member[];
  queue: QueueTrack[];
}

interface PanelBoxProps {
  title: string;
  focused: boolean;
  children: React.ReactNode;
}

function PanelBox({ title, focused, children }: PanelBoxProps): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={focused ? 'cyan' : 'gray'}
      paddingX={1}
      width={30}
      minHeight={10}
    >
      <Text bold color={focused ? 'cyan' : undefined}>
        {title}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}

export default function App(): React.ReactElement {
  const { exit } = useApp();
  const [focused, setFocused] = useState<PanelId>('nowPlaying');
  const [room, setRoom] = useState<RoomState | null>(null);

  useEffect(() => {
    const client = createIpcClient({
      onMessage(msg) {
        const m = msg as Record<string, unknown>;
        if (m['event'] === 'state:sync' && m['room']) {
          setRoom(m['room'] as RoomState);
        }
      },
      onEnd: exit,
      onError: () => exit(),
    });
    return () => { client.close(); };
  }, [exit]);

  useInput((input, key) => {
    if (input === 'q') {
      exit();
    } else if (key.tab) {
      const idx = PANELS.indexOf(focused);
      setFocused(PANELS[(idx + 1) % PANELS.length]!);
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>aux</Text>
        {room && <Text dimColor>  room: {room.name}</Text>}
      </Box>
      <Box gap={1}>
        <PanelBox title="Now Playing" focused={focused === 'nowPlaying'}>
          {room ? (
            <Text dimColor>Nothing playing yet</Text>
          ) : (
            <Text dimColor>Not in a room</Text>
          )}
        </PanelBox>
        <PanelBox title="Queue" focused={focused === 'queue'}>
          {room && room.queue.length > 0 ? (
            room.queue.map((track) => (
              <Text key={track.id}>{track.title}</Text>
            ))
          ) : (
            <Text dimColor>Queue is empty</Text>
          )}
        </PanelBox>
        <PanelBox title="Members" focused={focused === 'members'}>
          {room && room.members.length > 0 ? (
            room.members.map((m) => (
              <Text key={m.id}>{m.username}</Text>
            ))
          ) : (
            <Text dimColor>No members</Text>
          )}
        </PanelBox>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Tab: switch panel  ·  q: quit TUI</Text>
      </Box>
    </Box>
  );
}
```

- [ ] **Step 2: Check TypeScript compiles**

```bash
npm run build --workspace=packages/client
```

Expected: no errors. `dist/src/App.js` created.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/App.tsx
git commit -m "feat(client): Ink TUI App with 3 panels"
```

---

### Task 4: Update bin/aux.ts — daemon auto-start + TUI attach

**Files:**
- Modify: `packages/client/bin/aux.ts`

When no command is given: check if daemon is running (PID file + `kill -0`). If not, spawn `auxd` detached. Wait for `/tmp/aux.sock` to be available (up to 5s). Then render the Ink App.

`__dirname` resolution is needed for ESM: use `fileURLToPath(import.meta.url)`.

The daemon binary is at `../../daemon/bin/auxd.ts` relative to the client `bin/` directory.

- [ ] **Step 1: Replace packages/client/bin/aux.ts**

```ts
#!/usr/bin/env tsx
import { WebSocket } from 'ws';
import { readFileSync, existsSync } from 'node:fs';
import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveCredentials, loadCredentials } from '../src/credentials.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PID_FILE = '/tmp/aux.pid';
const IPC_PATH = '/tmp/aux.sock';
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
    await roomCommand('room:create', { name });
    return;
  }

  if (command === 'join') {
    const [name] = args;
    if (!name) {
      console.error('Usage: aux join <name>');
      process.exit(1);
    }
    await roomCommand('room:join', { name });
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
  throw new Error('Daemon not ready after 5s — check AUX_SERVER_URL and try again');
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

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Build to verify TypeScript**

```bash
npm run build --workspace=packages/client
```

Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add packages/client/bin/aux.ts
git commit -m "feat(client): daemon auto-start + TUI attach on aux (no args)"
```

---

### Task 5: Final verification

- [ ] **Step 1: Build all packages**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 2: Run server tests (unchanged)**

```bash
npm test --workspace=packages/server
```

Expected: all 15 tests pass.

- [ ] **Step 3: Manual smoke test (optional — requires running server)**

```bash
# Terminal 1: start server
AUX_SERVER_URL=ws://localhost:3000 JWT_SECRET=dev npm run dev:server

# Terminal 2: register + attach TUI
npx tsx packages/client/bin/aux.ts register alice password123
npx tsx packages/client/bin/aux.ts login alice password123
npx tsx packages/client/bin/aux.ts  # should start daemon and show TUI

# Close terminal 2. Terminal 3:
npx tsx packages/client/bin/aux.ts  # should reattach to same daemon

# Quit
npx tsx packages/client/bin/aux.ts quit
```

- [ ] **Step 4: Push and create PR**

```bash
git push -u origin feature/issue-3-tui-attach
gh pr create --title "feat: TUI client attaches to daemon, detachable (#3)" --body "$(cat <<'EOF'
## Summary
- `aux` (no args) auto-starts `auxd` if not running, waits for IPC socket, renders Ink TUI
- Ink TUI: three panels (Now Playing, Queue, Members) with Tab navigation and `q` to quit TUI
- Daemon stays alive when TUI exits — rerun `aux` to reattach
- IPC client (`src/ipc-client.ts`) connects to `/tmp/aux.sock`, parses newline-delimited JSON
- Client build confirmed: TypeScript compiles without errors

## Test Plan
- [ ] `npm run build` — no TypeScript errors
- [ ] `aux` starts daemon + shows TUI
- [ ] Closing terminal tab leaves daemon alive (check `/tmp/aux.pid` still exists)
- [ ] `aux` in new tab reattaches to same daemon
- [ ] Tab key cycles between panels
- [ ] `q` quits TUI without killing daemon
- [ ] `aux quit` kills daemon

Closes #3
EOF
)"
```
