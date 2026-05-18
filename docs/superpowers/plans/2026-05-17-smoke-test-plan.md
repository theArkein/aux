# Aux End-to-End Smoke Test Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan scenario-by-scenario. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify every user story from issues #1–#9 works end-to-end in a running system, catching integration failures that unit tests cannot.

**Architecture:** Three-terminal setup — Terminal A runs the server, Terminal B runs the primary user's daemon+TUI, Terminal C is used for multi-user scenarios (a direct WebSocket connection via `wscat` or a second shell user).

**Tech Stack:** Node.js ≥ 20, tsx, ws, ink, yt-dlp, mpv, wscat (for multi-user scenarios)

---

## Prerequisites

Before starting any scenario, confirm:

- [ ] Node.js ≥ 20: `node --version`
- [ ] yt-dlp installed: `which yt-dlp`
- [ ] mpv installed: `which mpv`
- [ ] wscat available: `npx wscat --version` (downloads on first use, that's fine)
- [ ] Dependencies installed: `npm install` from repo root
- [ ] `.env` exists in `packages/server/`:

```bash
cp packages/server/.env.example packages/server/.env
# Edit packages/server/.env and set:
# JWT_SECRET=smoke-test-secret
# PORT=7700
# DATABASE_PATH=./smoke-test.db
```

**Helper aliases** — paste these into every terminal tab before starting to avoid long paths:

```bash
# Run from repo root
alias aux-server="JWT_SECRET=smoke-test-secret DATABASE_PATH=./smoke-test.db npx tsx packages/server/src/server.ts"
alias aux="npx tsx packages/client/bin/aux.ts"
alias auxd="npx tsx packages/daemon/bin/auxd.ts"
alias aux-ws="npx wscat -c ws://localhost:7700"
```

**Reset between scenarios** — run this to clear all state:

```bash
aux quit 2>/dev/null; rm -f /tmp/aux.sock /tmp/aux.pid /tmp/mpv-aux.sock
rm -f packages/server/smoke-test.db
rm -f ~/.aux-credentials  # or wherever credentials.ts saves them
```

> **Note on credentials path:** The `credentials.ts` module in both `packages/client` and `packages/daemon` saves to a file in the user's home directory. Check `packages/client/src/credentials.ts` for the exact path if the path above doesn't match.

---

## Scenario 0: Automated Tests Pass (Baseline)

Run the unit test suite before any manual testing. If tests fail here, the smoke test may surface the same bugs with more noise.

- [ ] **Run all tests**

```bash
npm test --workspaces --if-present 2>&1 | tail -40
```

Expected: All test suites pass. Note any failures — they indicate known broken areas to watch during smoke testing.

---

## Scenario 1: Server Bootstrap + Daemon Auth (Issue #1)

Tests: server starts cleanly, register, login, JWT token auth, guest auth.

### Setup

- [ ] **Open Terminal A. Start the server:**

```bash
aux-server
```

Expected output:
```
aux-server listening on :7700
```

Leave Terminal A running for all subsequent scenarios.

### 1a: Register a new user

- [ ] **Open Terminal B. Register Alice:**

```bash
aux register alice alice123
```

Expected:
```
Logged in as alice
```

Credentials are now saved to disk. Confirm with:

```bash
cat ~/.aux-credentials  # (adjust path if needed — check credentials.ts)
```

Expected: a JSON file with `token` and `username` fields.

### 1b: Login with existing credentials

- [ ] **Clear saved credentials, then login:**

```bash
rm -f ~/.aux-credentials
aux login alice alice123
```

Expected:
```
Logged in as alice
```

### 1c: Wrong password rejected

- [ ] **Attempt login with bad password:**

```bash
aux login alice wrongpassword
```

Expected: prints an error (`INVALID_CREDENTIALS` or similar) and exits non-zero. Does NOT save credentials.

### 1d: Duplicate registration rejected

- [ ] **Try to register the same username again:**

```bash
aux register alice alice123
```

Expected: error message (`USER_EXISTS` or similar).

### 1e: Daemon authenticates via saved token

- [ ] **Ensure credentials are saved (re-login if needed), then start the daemon manually:**

```bash
auxd &
sleep 2
cat /tmp/aux.pid  # Should print a PID
```

Expected: daemon starts, prints `[auxd] running (pid <N>)`, and creates `/tmp/aux.pid`.

- [ ] **Check daemon is connected to server** — look at Terminal A output for a new WebSocket connection. Expected: server log shows a connection, and the daemon sends an auth event.

- [ ] **Kill the daemon:**

```bash
aux quit
```

Expected: `Daemon stopped.` — `/tmp/aux.pid` and `/tmp/aux.sock` are removed.

### 1f: Daemon starts as guest when no credentials

- [ ] **Delete credentials and start daemon:**

```bash
rm -f ~/.aux-credentials
auxd &
sleep 2
```

Expected: Terminal A shows the server assigned a guest username (`guest_xxxx`). Daemon log: `[auxd] running (pid <N>)`.

- [ ] **Kill the daemon and restore Alice's credentials:**

```bash
aux quit
aux login alice alice123
```

---

## Scenario 2: Named Room Create + Join (Issue #2)

Tests: room creation, room joining, host transfer on leave, duplicate name rejection.

### Setup

- [ ] Ensure Alice is logged in (`~/.aux-credentials` exists).
- [ ] Server is running in Terminal A.

### 2a: Create a room

- [ ] **Create room "lounge":**

```bash
aux create lounge
```

Expected:
```
Room: lounge (members: alice)
```

Terminal A should log the room create event.

### 2b: Duplicate room name rejected

- [ ] **Try creating the same room again:**

```bash
aux create lounge
```

Expected: error (`ROOM_EXISTS` or similar).

### 2c: Join an existing room

- [ ] **Register Bob in Terminal C, then join:**

```bash
# Terminal C
aux register bob bob123
aux join lounge
```

Expected:
```
Room: lounge (members: alice, bob)
```

### 2d: Leave room triggers host transfer

- [ ] **In Terminal B, have Alice leave the room by joining a different room or directly testing via wscat:**

Open Terminal C with wscat, log in as alice, create lounge, then log in as bob and join. Then have alice leave and verify bob becomes host.

```bash
# Terminal C
npx wscat -c ws://localhost:7700
```

Paste (one line at a time, wait for response):
```json
{"event":"auth","action":"login","username":"alice","password":"alice123"}
```
Expected response: `{"event":"auth:ok", ...}`

```json
{"event":"room:create","name":"transfer-test"}
```
Expected: `{"event":"state:sync","room":{"name":"transfer-test","hostId":"<alice-id>",...}}`

Open a second wscat session as Bob, join the room, then have Alice disconnect (Ctrl+C). The next `state:sync` Bob receives should show `hostId` changed to Bob's ID.

---

## Scenario 3: TUI Client Attaches to Daemon (Issue #3)

Tests: daemon auto-spawns on `aux` with no args, TUI renders all panels, `q` exits TUI but daemon stays, second `aux` attaches to same daemon.

### Setup

- [ ] Alice logged in, server running. No daemon running (`aux quit` if needed).

### 3a: TUI auto-starts daemon and renders

- [ ] **Run aux with no args:**

```bash
aux
```

Expected within ~5s:
- Terminal shows the Ink TUI with four panels: `Now Playing`, `Queue`, `Members`, `Friends`
- Top line: `aux  room: ` (no room joined yet — "Not in a room" in Now Playing panel)
- Bottom: help text `Tab: switch panel  ·  s: search  ·  p: Spotify import  ·  x: skip  ·  +/-: volume  ·  q: quit TUI`
- `/tmp/aux.pid` and `/tmp/aux.sock` exist

### 3b: Tab switches focused panel

- [ ] **Press `Tab` repeatedly.** Each press should cycle the focused panel — the active panel's border turns cyan and its title bolds.

Expected cycle: `Now Playing` → `Queue` → `Members` → `Friends` → `Now Playing` → …

### 3c: q quits TUI but keeps daemon alive

- [ ] **Press `q` in the TUI.**

Expected: TUI exits, shell prompt returns. Daemon still running:

```bash
cat /tmp/aux.pid  # prints PID
kill -0 $(cat /tmp/aux.pid) && echo "daemon alive"
```

Expected: `daemon alive`

### 3d: Second aux invocation attaches to existing daemon

- [ ] **Open a new terminal tab and run:**

```bash
aux
```

Expected: TUI renders immediately (no daemon spawn delay). Both terminal tabs show TUIs connected to the same daemon. Changes in one tab (e.g., room state) should appear in both.

- [ ] **Exit both TUIs with `q`.**

### 3e: aux quit stops daemon

- [ ] **With daemon running:**

```bash
aux quit
```

Expected: `Daemon stopped.`

```bash
ls /tmp/aux.pid 2>&1  # should say "No such file"
ls /tmp/aux.sock 2>&1  # should say "No such file"
```

---

## Scenario 4: YouTube Search + Queue (Issue #4)

Tests: search flow in TUI, results display, queuing a track, queue panel updates.

**Requires:** yt-dlp installed and network access.

### Setup

- [ ] Alice logged in, server running, room "lounge" created:

```bash
aux create lounge
```

- [ ] Launch TUI:

```bash
aux
```

### 4a: Enter search mode

- [ ] **Press `s`.** Expected: search overlay appears at top:
```
Search: █
Enter: search  Esc: cancel
```

### 4b: Type a query and search

- [ ] **Type `daft punk get lucky` and press Enter.**

Expected (after ~5–10s for yt-dlp to respond):
- Results overlay shows a numbered list of tracks with title, artist, and duration
- First result is highlighted in cyan with `▶` prefix
- Bottom shows: `↑↓: navigate  Enter: queue  Esc: cancel`

### 4c: Navigate results

- [ ] **Press `↓` then `↑`.** Expected: highlighted selection moves.

### 4d: Queue a track

- [ ] **With a track highlighted, press Enter.**

Expected:
- Search overlay closes
- `Queue` panel in the main TUI now shows the track (title, duration, username)
- Status updates in the TUI

### 4e: Escape cancels search

- [ ] **Press `s`, type `something`, then press `Esc`.**

Expected: returns to normal mode, no results shown, query cleared.

---

## Scenario 5: Audio Playback + Sync (Issue #5)

Tests: playback starts when a track is queued, progress bar ticks, `playback:next` event triggers mpv.

**Requires:** mpv installed, yt-dlp installed.

### Setup

- [ ] Alice in room "lounge" with TUI open, one track in queue from Scenario 4.

### 5a: Playback starts automatically

- [ ] **Observe the TUI.** After queuing the first track, within ~2–3s:

Expected:
- `Now Playing` panel shows the track title and artist
- A progress bar `[== ]` appears and updates every second
- Time counter shows `0:05 / 3:42` (or similar)
- Audio plays from your speakers

If audio plays and the progress bar ticks — **pass**.

### 5b: Progress bar advances

- [ ] **Wait 30 seconds.** Expected: elapsed time increases, progress bar fills proportionally.

### 5c: Track ends and next plays (if queue has multiple)

- [ ] **Queue a second track** (repeat Scenario 4 steps to search and queue another). Wait for the first track to finish or skip it (Scenario 6).

Expected: when track 1 ends, track 2 starts automatically within ~1s. `Now Playing` panel updates.

### 5d: Multi-user sync (two-machine test)

> If you have a second machine: set `AUX_SERVER_URL=ws://<alice-machine-ip>:7700` and run `aux join lounge` there. Both machines should start playing the same track within 200ms of each other (you'll hear them in sync if close together).
>
> On a single machine: verify `startAt` logic by reading `packages/daemon/__tests__/playback-engine.test.ts` — the unit tests cover the timing contract. The integration smoke here relies on the track starting correctly (Scenario 5a).

---

## Scenario 6: Skip + Vote-Skip (Issue #6)

Tests: single-user skip (1 vote = 100% of 1 member), two-user vote-skip threshold.

### Setup

- [ ] Alice in room "lounge" with a track playing (from Scenario 5).

### 6a: Single-user skip

- [ ] **In TUI, press `x`.**

Expected: current track stops, next track starts (if queued), or `Now Playing` shows "Nothing playing" if queue is empty.

If the queue was empty, queue another track (Scenario 4) and verify it starts playing, then press `x` again.

### 6b: Vote-skip counter shows in TUI

- [ ] **Queue two tracks. Let the first start playing.**
- [ ] **Via wscat in Terminal C, join as Bob:**

```bash
npx wscat -c ws://localhost:7700
```

```json
{"event":"auth","action":"login","username":"bob","password":"bob123"}
```
```json
{"event":"room:join","name":"lounge"}
```

Now there are 2 members. Alice's single vote (`x`) is 1/2 = 50% — does NOT trigger skip (threshold is `> 50%`). Verify:

- [ ] **Press `x` in Alice's TUI.**

Expected in TUI: `1/2 votes to skip` shows in the Now Playing panel. Track keeps playing.

- [ ] **In the wscat session (Bob), send a skip vote:**

```json
{"event":"queue:skip"}
```

Expected: 2/2 = 100% > 50% — track skips. Both Alice's TUI and the wscat session should receive a new `state:sync` or `playback:next` event. Track changes.

### 6c: Skip votes reset on next track

- [ ] **After the skip triggers a new track, verify** that the `skipVotes` array in `state:sync` is empty (Bob's wscat session will show the raw JSON).

---

## Scenario 7: Guest Mode (Issue #7)

Tests: connecting without credentials gets guest username, guest can join/queue, guest cannot create rooms.

### Setup

- [ ] Server running, Alice's room "lounge" exists.

### 7a: Guest join

- [ ] **In Terminal C, remove any saved credentials and join:**

```bash
# Terminal C — use a different HOME to avoid affecting Alice's credentials
HOME=/tmp/smoke-guest npx tsx packages/client/bin/aux.ts join lounge
```

Expected:
```
Room: lounge (members: alice, guest_xxxx)
```

The `guest_xxxx` username is auto-generated by the server. Terminal A log should show the guest connect and join.

### 7b: Guest cannot create rooms

- [ ] **In the same guest session terminal (no credentials):**

```bash
HOME=/tmp/smoke-guest npx tsx packages/client/bin/aux.ts create newroom
```

Expected:
```
Guests cannot create rooms. Register first: aux register <username> <password>
```

Process exits with non-zero code.

### 7c: Guest can queue tracks

- [ ] **In Terminal C with guest daemon running on its own socket... **

> **Single-machine limitation:** the daemon uses a hardcoded socket `/tmp/aux.sock` and PID file `/tmp/aux.pid`, so two daemons cannot coexist. To test guest queuing in the TUI, you need a second machine. On a single machine, verify guest queue via wscat:

```bash
npx wscat -c ws://localhost:7700
```

```json
{"event":"auth","action":"guest"}
```

Expected: `{"event":"auth:ok","username":"guest_xxxx","token":"...","id":"..."}`

```json
{"event":"room:join","name":"lounge"}
```

Expected: `state:sync` with room state.

```json
{"event":"queue:add","youtubeUrl":"https://www.youtube.com/watch?v=5NV6Rdv1a3I","title":"Test Track","artist":"Test Artist","duration":180}
```

Expected: Alice's TUI receives `queue:update` and the track appears in her Queue panel.

### 7d: Guest presence clears on disconnect

- [ ] **Ctrl+C the wscat session.** Alice's TUI Members panel should update — guest disappears from the member list within a few seconds (next `state:sync` or `presence` event).

---

## Scenario 8: Friends + Presence (Issue #8)

Tests: add friend, friends panel shows online/offline status, friend's room name shown when online, Enter in friends panel joins friend's room.

### Setup

- [ ] Alice and Bob are both registered.
- [ ] Server running.

### 8a: Add a friend

- [ ] **As Alice, add Bob:**

```bash
aux friend add bob
```

Expected (Bob not currently online):
```
Added bob as a friend.
```

Expected (if Bob happens to be online in a room):
```
Added bob as a friend. They are online in room: <roomname>.
```

### 8b: Friends panel shows offline friend

- [ ] **Launch Alice's TUI:**

```bash
aux
```

- [ ] **Press `Tab` until `Friends` panel is focused.**

Expected: Bob listed with `○` (offline indicator).

### 8c: Friend shows online when they connect

- [ ] **In Terminal C, log in as Bob and join the room:**

```bash
npx wscat -c ws://localhost:7700
```

```json
{"event":"auth","action":"login","username":"bob","password":"bob123"}
```
```json
{"event":"room:join","name":"lounge"}
```

- [ ] **Watch Alice's Friends panel.** Within a few seconds, Bob should update to:

```
  bob ● lounge
```

(green dot, room name shown)

### 8d: Join friend's room via Enter

- [ ] **In Alice's TUI, navigate to Friends panel (`Tab`). Navigate to Bob using `↑`/`↓`. Press `Enter`.**

Expected: Alice joins Bob's room. The `Members` panel updates to show both Alice and Bob. TUI header shows `room: lounge`.

### 8e: Friend goes offline

- [ ] **Ctrl+C the Bob wscat session.**

Expected: Alice's Friends panel updates Bob to `○` (offline) within a few seconds.

---

## Scenario 9: Spotify Playlist Import (Issue #9)

Tests: no-client-ID error, OAuth URL shown in TUI, playlist browser, import progress, tracks queued.

**Requires:** A Spotify developer app with Client ID. Create one at https://developer.spotify.com/dashboard — set redirect URI to `http://localhost:8888/callback`.

### Setup

- [ ] Alice in room "lounge" with TUI open.

### 9a: No SPOTIFY_CLIENT_ID shows error

- [ ] **In TUI (no `SPOTIFY_CLIENT_ID` env var set), press `p`.**

Expected: status message in yellow:
```
Set SPOTIFY_CLIENT_ID env var. Create an app at https://developer.spotify.com/dashboard
```

TUI returns to normal mode.

### 9b: OAuth flow initiates

- [ ] **Restart TUI with the client ID set:**

```bash
aux quit
SPOTIFY_CLIENT_ID=<your-client-id> aux
```

- [ ] **In TUI, press `p`.**

Expected: TUI switches to `spotify-loading` mode:
```
Opening Spotify auth in browser...
If browser did not open, visit:
<oauth-url>
Esc: cancel
```

A browser should open (or the URL is printed for manual navigation). Visit the URL, authorize the app.

### 9c: Playlist browser appears after auth

Expected after completing OAuth in browser: TUI switches to `spotify-playlists` mode:
```
Spotify Playlists
▶ My Playlist (23 tracks)
  Another Playlist (10 tracks)
  ...

↑↓: navigate  Enter: import playlist  Esc: cancel
```

### 9d: Navigate playlist list

- [ ] **Press `↓` and `↑`.** Expected: selection moves, `▶` moves with it.

### 9e: Import a playlist

- [ ] **Select a small playlist (≤5 tracks to save time) and press Enter.**

Expected: TUI switches to `spotify-importing` mode:
```
Importing Spotify playlist...
Resolved: 0 / 5

Esc: cancel
```

Counter increments as tracks resolve:
```
Resolved: 3 / 5
Skipped (no YouTube match): 1
```

### 9f: Import completes, tracks in queue

Expected after all tracks processed: TUI returns to normal mode with a status message:
```
Spotify import: 4 queued, 1 failed
```

- [ ] **Check Queue panel.** All resolved tracks should appear in the queue. If a track was playing, verify the queue shows subsequent tracks.

### 9g: Escape cancels import mid-flow

- [ ] **Start an import of a large playlist (20+ tracks). Press `Esc` during import.**

Expected: TUI returns to normal mode immediately. Tracks resolved before Esc was pressed remain in the queue; the import loop stops (no more `queue:add` events to server).

---

## Full Run Checklist

Run through this after completing all scenarios to confirm no regressions:

```
Auth
 [ ] Register new user
 [ ] Login with correct credentials
 [ ] Wrong password rejected
 [ ] Duplicate username rejected
 [ ] Daemon uses saved token on startup
 [ ] Daemon falls back to guest with no credentials

Rooms
 [ ] Create named room
 [ ] Join existing room
 [ ] Duplicate room name rejected
 [ ] Host transfer when creator leaves

TUI
 [ ] aux (no args) auto-spawns daemon
 [ ] All four panels render
 [ ] Tab cycles panel focus
 [ ] q exits TUI, daemon stays alive
 [ ] Second aux attaches to same daemon
 [ ] aux quit stops daemon

Search + Queue
 [ ] s enters search mode
 [ ] Search returns results
 [ ] ↑↓ navigates results
 [ ] Enter queues selected track
 [ ] Queue panel shows queued track
 [ ] Esc cancels search

Playback
 [ ] First queued track triggers playback
 [ ] Progress bar ticks every second
 [ ] Track title/artist shown in Now Playing
 [ ] Next track plays automatically when current ends

Skip
 [ ] x registers skip vote
 [ ] Single user in room: x skips immediately
 [ ] Two users: 1 vote shows counter, does not skip
 [ ] Two users: 2nd vote triggers skip
 [ ] Skip votes reset after skip

Guest Mode
 [ ] Join without credentials gets guest_xxxx username
 [ ] Guest can queue tracks
 [ ] create command rejected for guest
 [ ] Guest disappears from members on disconnect

Friends
 [ ] aux friend add <username> adds friend
 [ ] Friends panel shows offline friend with ○
 [ ] Online friend shows ● and room name
 [ ] Enter in Friends panel joins friend's room

Spotify Import
 [ ] p with no SPOTIFY_CLIENT_ID shows error
 [ ] p with client ID starts OAuth flow
 [ ] Auth URL shown in TUI
 [ ] Playlist browser renders after auth
 [ ] Import progress updates in real time
 [ ] Queued tracks appear in Queue panel
 [ ] Esc cancels in-progress import
```

---

## Known Single-Machine Limitations

These tests require two separate machines (or two OS users with separate home directories) for full fidelity. Unit tests cover the underlying logic:

| Test | Limitation | Unit Test Coverage |
|------|------------|-------------------|
| Multi-user sync timing (±200ms) | Two daemons need separate socket paths (hardcoded) | `packages/daemon/__tests__/playback-engine.test.ts` |
| Guest TUI (full UI flow) | Second daemon conflicts with first on `/tmp/aux.sock` | `packages/server/__tests__/ws-guest.test.ts` |
| Vote-skip with two TUI clients | Same socket conflict | `packages/server/__tests__/ws-skip.test.ts` |

**Workaround:** use `npx wscat -c ws://localhost:7700` for the second user in multi-user scenarios — it gives direct server access without spawning a conflicting daemon.
