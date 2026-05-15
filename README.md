# aux

Social music CLI for developers. Create or join a named room, queue YouTube tracks collaboratively, and listen in sync — all from the terminal.

```
aux register          # create account
aux login             # log in
aux create lofi       # create room named "lofi"
aux join lofi         # join a room
aux search pink floyd # search YouTube
aux quit              # stop the daemon
```

## Prerequisites

- Node.js ≥ 20
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) — audio resolution
- [`mpv`](https://mpv.io) — audio playback

```bash
# macOS
brew install yt-dlp mpv
```

## Install

```bash
npm install -g aux   # not yet published
```

## Architecture

```
aux (TUI client)  ←──Unix socket──→  auxd (daemon)  ←──WebSocket──→  aux-server
                                          │
                                     yt-dlp + mpv
```

- **`auxd`** runs in the background, survives terminal closes, manages the WebSocket connection to the server and local audio playback.
- **`aux`** attaches to the daemon from any terminal tab and renders room state.
- **`aux-server`** is the single source of truth for all room state, user accounts, and playback timing.

## Features

- Named rooms (`aux join apple`) — no random codes
- Collaborative YouTube queue with now-playing + progress bar
- Synchronized playback across all room members
- Guest mode — join without an account
- Friends + presence
- Vote-skip (>50% of present members)
- Spotify playlist import (resolves to YouTube)
- AI DJ mode (optional, requires Anthropic API key)

## Self-Hosting the Server

```bash
cd packages/server
cp .env.example .env   # set JWT_SECRET
npm install
npm start
```

Deployable to Railway or Fly.io. State stored in SQLite.

## Development

```bash
npm install            # install all workspaces
npm test               # run all tests
npm run dev:server     # run server with file watching
```

## License

MIT
