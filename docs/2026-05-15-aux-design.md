# aux — PRD
**Date:** 2026-05-15  
**Status:** Ready for implementation

---

## Problem Statement

Developers who want to share music with friends while working have no good terminal-native option. Discord music bots require a Discord server and a running voice channel. Spotify's social features are locked to the Spotify app. Neither lives in the terminal, neither fits a developer's workflow, and neither gives developers the lightweight room-based social experience they actually want.

---

## Solution

`aux` is a social music CLI for developers. Users create or join rooms, collaboratively queue tracks from YouTube, and listen in sync — all from the terminal. A long-running background daemon keeps the session alive across terminal tabs. Friends can see each other's presence and join rooms via invite codes. An optional AI DJ mode uses Claude to suggest the next track based on the room's listening history.

---

## User Stories

1. As a developer, I want to start `aux` from my terminal and have it persist when I close the tab, so that my session isn't interrupted by normal terminal usage.
2. As a developer, I want to reattach to my running session from any terminal tab, so that I can check the queue without disrupting my workflow.
3. As a developer, I want to register a username and password, so that friends can find me by name.
4. As a developer, I want to log in with my username, so that my identity and friends persist across sessions.
5. As a guest, I want to join a room without registering, so that I can listen with others without friction.
6. As a guest, I want a temporary auto-generated username (e.g. `guest_x7k2`), so that others in the room can identify me.
7. As a developer, I want to create a room with a unique human-readable name (e.g. `apple`), so that I can share something memorable instead of a random code.
8. As a developer, I want to join a room by its name, so that joining is simple and memorable.
7. As a developer, I want to search YouTube by query from within the TUI, so that I can find tracks without leaving the terminal.
8. As a developer, I want to add a track to the room queue, so that others can hear what I want to play next.
9. As a developer, I want to see the current queue with track titles, duration, and who queued each track, so that I know what's coming up.
10. As a developer, I want to hear audio play automatically in sync with everyone else in the room, so that we're all listening to the same thing at the same time.
13. As a developer, I want to skip the current track (as host or via vote-skip), so that the room can move on when needed.
14. As a developer, I want to see which friends are currently in a room, so that I know who to join.
13. As a developer, I want to add friends by username, so that I can see their presence without exchanging invite codes every time.
14. As a developer, I want to see a friend's current room and join it directly, so that joining is frictionless.
15. As a developer, I want to import a Spotify playlist into the queue, so that I can use my existing music collections.
16. As a developer, I want Spotify tracks to automatically resolve to YouTube equivalents, so that playback works without needing a Spotify Premium account.
17. As a developer, I want to enable AI DJ mode, so that Claude can suggest the next track based on what the room has been listening to.
18. As a developer, I want AI DJ suggestions to show the reasoning (e.g. "similar tempo, same genre"), so that I can understand and trust the recommendation.
19. As a developer, I want to accept or reject an AI DJ suggestion, so that I stay in control of the queue.
20. As a developer, I want to leave a room without killing the daemon, so that I can stop listening without ending my session.
21. As a developer, I want to explicitly quit the daemon with `aux quit`, so that I have full control over when the background process ends.
22. As a developer, I want the TUI to show now-playing with track title, artist, progress bar, and duration, so that I always know what's playing.
23. As a developer, I want volume control from within the TUI, so that I don't need to leave to adjust audio.
24. As a developer, I want to see which room members are currently online vs. away, so that I know who's actively listening.
25. As a developer, I want the room host to have special controls (skip, clear queue, kick), so that rooms can be moderated.

---

## Implementation Decisions

### Architecture: Stateful Server (Approach B)
The server owns all room state: queue, playback position, membership, user accounts. Clients are dumb renderers — they display what the server broadcasts. This eliminates sync conflicts and simplifies client logic.

### Daemon + Client Split
- **`auxd` (daemon):** Long-running background process. Owns the WebSocket connection to the server, drives audio playback via `yt-dlp` and `mpv` as child processes, and exposes a Unix socket for IPC with the TUI client.
- **`aux` (TUI client):** Attaches to the daemon via Unix socket on startup. Renders room state received from daemon. Detaches cleanly on terminal close. Reconnects automatically on reattach.
- Daemon lifecycle: `aux` starts the daemon if not running. `aux quit` explicitly kills it.

### Audio Pipeline
`yt-dlp` resolves YouTube URLs and streams audio. `mpv` receives the stream and handles local playback. Both run as Node.js child processes managed by the daemon.

### Sync Engine
Server sends a `playback:next` event containing the YouTube URL and a `startAt` Unix timestamp (200ms in the future). All daemons buffer until `startAt` then begin playback simultaneously. This tolerates ~200ms of network variance.

### TUI: Ink (React for CLI)
Full-screen terminal UI built with Ink. Panels: now-playing, queue, room members, search. Keyboard-driven navigation.

### Transport: WebSockets
Server uses the `ws` library. All real-time events (queue updates, playback signals, presence) flow over a persistent WebSocket connection per daemon.

### User Accounts
Username + hashed password stored server-side. JWT-based auth. Friend relationships stored as a simple adjacency list on the server.

### Guest Mode
Users who join without an account get a temporary `guest_<4-char-id>` username generated server-side. Guests can join rooms by name, queue tracks, and vote-skip. Guests cannot add friends, appear in persistent presence history, or create rooms. Guest sessions expire when the daemon disconnects.

### Room Naming
Rooms have a unique, creator-defined name (e.g. `apple`). Names are lowercase alphanumeric, 3–20 chars, unique across the server. The name is the join identifier — `aux join apple`. No separate random invite code. If a name is taken, the server rejects creation and the user picks another.

### Room Model
```
Room {
  id: string
  name: string          // unique, creator-defined (e.g. "apple")
  hostId: string
  memberIds: string[]
  queue: Track[]
  nowPlaying: Track | null
  playbackPosition: number
  createdAt: timestamp
}

Track {
  id: string
  youtubeUrl: string
  title: string
  artist: string
  duration: number
  thumbnail: string
  queuedBy: string      // userId
}
```

### WebSocket Event Contract
**Client → Server:**
- `auth` — login/register
- `room:create` — create room with unique name
- `room:join` — join by room name (guests included)
- `room:leave` — leave room
- `queue:add` — add track to queue
- `queue:skip` — skip current track
- `friend:add` — add friend by username
- `dj:suggest` — request AI DJ suggestion

**Server → Client:**
- `state:sync` — full room state on join
- `queue:update` — queue changed
- `playback:next` — next track + `startAt` timestamp
- `presence` — member joined/left/online/away

### Spotify Bridge
OAuth 2.0 PKCE flow (no backend secret needed). Fetch playlist tracks from Spotify Web API. Resolve each track to YouTube via `yt-dlp` search (`ytsearch:"<title> <artist>"`). Cache resolutions locally to avoid repeat lookups.

### AI DJ Mode
When enabled, after each track ends the daemon sends `dj:suggest` to the server. Server calls Claude API with the last 10 tracks as context and requests a YouTube search query + reasoning. Server returns suggestion to the room. Any room member can accept or reject the suggestion. Uses prompt caching on the track history context to reduce latency and cost.

### Hosting
Single `server.js` deployable to Railway or Fly.io. Stateless between restarts except user/room data, which is stored in SQLite.

---

## Testing Decisions

Good tests verify external behavior through public interfaces — not implementation details. A test should break when behavior changes, not when internal structure is refactored.

**Modules to test:**

**`sync-engine`** — Unit test the timestamp coordination logic. Given a `startAt` value and a simulated clock, verify daemons start within tolerance. Test edge cases: late join, network delay, clock skew.

**`youtube-resolver`** — Integration test against `yt-dlp` subprocess. Given a search query, verify a valid YouTube URL and metadata are returned. Test failure cases: no results, private video, unavailable region.

**`aux-server` (room state logic)** — Unit test room state transitions: create room, join, queue track, skip, leave, host transfer. Verify queue ordering, vote-skip threshold (majority of present members, >50%), and `playback:next` event emission. Use in-memory state, no WebSocket needed for these tests.

No prior art — greenfield project.

---

## Out of Scope

- Mobile or web clients
- Direct audio streaming between peers (P2P)
- Spotify playback (audio via Spotify) — only playlist import is supported
- Recording or saving listening sessions
- Private/password-protected rooms (all rooms are joinable by name)
- Lyrics display
- Equalizer or audio effects
- Paid tiers or monetization

---

## Further Notes

- `yt-dlp` and `mpv` are runtime dependencies users must install separately. The CLI should check for their presence on startup and provide clear install instructions if missing.
- The server should be designed for self-hosting. Configuration via environment variables.
- AI DJ mode requires an Anthropic API key, configured via `ANTHROPIC_API_KEY` env var. The feature is silently disabled if the key is absent.
- Room names are lowercase alphanumeric, 3–20 chars. The server validates uniqueness at creation time and returns a clear error if taken.
