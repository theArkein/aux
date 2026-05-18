# aux — Claude Code Guide

## What this is

`aux` is a social music CLI for developers. Users create or join named rooms, collaboratively queue YouTube tracks, and listen in sync — all from the terminal. A background daemon (`auxd`) keeps the session alive across terminal tabs.

## Architecture

Three packages in an npm workspace monorepo:

| Package | Role |
|---|---|
| `packages/server` | Stateful WebSocket server. Owns all room state, user accounts, playback timing. SQLite for persistence. |
| `packages/daemon` | `auxd` — long-running background process. Holds the WS connection to the server, drives audio via `yt-dlp` + `mpv` child processes, exposes a Unix socket for IPC with the TUI. |
| `packages/client` | `aux` — Ink TUI. Attaches to the daemon via Unix socket. Renders what the daemon broadcasts. Detaches cleanly on terminal close. |

The daemon is the audio and network owner. The client is a dumb renderer.

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js ≥ 20
- **Server transport:** `ws` (WebSocket library)
- **Server storage:** `better-sqlite3` (SQLite)
- **Auth:** `bcryptjs` (password hashing) + `jsonwebtoken` (JWT)
- **TUI:** `ink` + `react` (React for CLI)
- **Audio:** `yt-dlp` + `mpv` (external binaries, must be installed by user)
- **Dev runner:** `tsx` (runs TypeScript directly, no compile step in dev)
- **Build:** `tsc` (compiles to `dist/` for production)
- **Testing:** Node.js built-in `node:test` + `assert`, run via `tsx --test`

## Key Concepts

### Sync Engine
Server sends `playback:next` with `{ youtubeUrl, startAt }` where `startAt` is a Unix timestamp 200ms in the future. All daemons buffer until `startAt`, then start `mpv` simultaneously. Tolerates ~200ms of network variance.

### Room Model
```
Room { id, name (unique, creator-defined, e.g. "apple"), hostId, memberIds[], queue[], nowPlaying, playbackPosition, createdAt }
Track { id, youtubeUrl, title, artist, duration, thumbnail, queuedBy (userId) }
```

### WebSocket Events
**Client → Server:** `auth`, `room:create`, `room:join`, `room:leave`, `queue:add`, `queue:skip`, `friend:add`, `dj:suggest`
**Server → Client:** `state:sync`, `queue:update`, `playback:next`, `presence`

### Daemon IPC
Daemon listens on a Unix socket at `/tmp/aux.sock`. TUI client connects to this socket. Protocol is newline-delimited JSON.

### Guest Mode
Users who connect without credentials get a `guest_<4-char-id>` username. Guests can join rooms, queue tracks, vote-skip. Guests cannot create rooms, add friends, or persist across daemon restarts.

### Vote-Skip
Skip triggers when >50% of present room members have voted to skip.

## Development Workflow

```bash
# Install all dependencies
npm install

# Run server in dev mode (tsx, no compile step)
npm run dev:server

# Build all packages for production
npm run build

# Run tests for a specific package
npm test --workspace=packages/server
```

## TypeScript Conventions

- All source files use `.ts` extension
- Strict mode enabled (`"strict": true` in tsconfig)
- Each package has its own `tsconfig.json` extending the root `tsconfig.base.json`
- Shared types/interfaces live in `src/types.ts` within each package
- Bin entry points use `#!/usr/bin/env tsx` shebang for development
- Production bins point to compiled `dist/` output

## Testing Philosophy

Tests verify external behavior through public interfaces — not implementation details. A test should break when behavior changes, not when internals are refactored.

**Modules under test:**
- `packages/server` — room state transitions (create, join, queue, skip, leave, host transfer). Use in-memory state; no WebSocket plumbing needed.
- `packages/server` — auth logic (register, login, JWT round-trip).
- `packages/daemon` — sync engine timestamp coordination (given `startAt`, verify start within tolerance).
- `packages/daemon` — `yt-dlp` subprocess integration (given query, verify valid URL + metadata returned).

## External Dependencies

Users must have `yt-dlp` and `mpv` installed. Check for them on daemon startup and print install instructions if missing.

## Environment Variables (server)

```
PORT=7700
JWT_SECRET=<required>
DATABASE_PATH=./aux.db
ANTHROPIC_API_KEY=<optional, enables AI DJ mode>
```

## Issue Dependency Graph

```
#1 Server bootstrap + daemon auth
├── #2 Named room create + join
│   ├── #4 YouTube search + queue
│   │   ├── #5 Audio playback + sync
│   │   │   ├── #6 Skip + vote-skip
│   │   │   └── #10 AI DJ mode
│   │   └── #9 Spotify playlist import
│   └── #7 Guest mode
└── #3 TUI client attaches to daemon
    ├── #4 YouTube search + queue (also blocked by #2)
    └── #8 Friends + presence (also blocked by #1)
```
