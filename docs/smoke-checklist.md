# Aux Smoke Run Checklist

Each item is one check with the exact command to run it. Items marked **[visual]** require eyes on the TUI — no command to run, just observe. Items marked **[ws]** use a raw WebSocket session via wscat.

**Reset state before a full run:**
```bash
npx tsx packages/client/bin/aux.ts quit 2>/dev/null
rm -f /tmp/aux.sock /tmp/aux.pid /tmp/mpv-aux.sock
rm -f packages/server/smoke-test.db
rm -f ~/.aux-credentials
```

**Start server (leave running for all checks):**
```bash
JWT_SECRET=smoke-test-secret DATABASE_PATH=./packages/server/smoke-test.db \
  npx tsx packages/server/src/server.ts
```

---

## Auth

**Register new user**
```bash
npx tsx packages/client/bin/aux.ts register alice alice123
# Expected: Logged in as alice
```

**Login with correct credentials**
```bash
rm -f ~/.aux-credentials
npx tsx packages/client/bin/aux.ts login alice alice123
# Expected: Logged in as alice
cat ~/.aux-credentials   # {"token":"...","username":"alice"}
```

**Wrong password rejected**
```bash
npx tsx packages/client/bin/aux.ts login alice wrongpassword
# Expected: error printed (INVALID_CREDENTIALS), exit 1
echo "exit: $?"
```

**Duplicate username rejected**
```bash
npx tsx packages/client/bin/aux.ts register alice alice123
# Expected: error (USER_EXISTS or USERNAME_TAKEN), exit 1
```

**Daemon uses saved token on startup**
```bash
# Ensure alice is logged in first
npx tsx packages/client/bin/aux.ts login alice alice123
# Start daemon, check server log shows authenticated connection
AUX_SERVER_URL=ws://localhost:7700 npx tsx packages/daemon/bin/auxd.ts &
sleep 2
# Server terminal should show auth event for alice; daemon log: [auxd] running (pid N)
cat /tmp/aux.pid
npx tsx packages/client/bin/aux.ts quit
```

**Daemon falls back to guest with no credentials**
```bash
rm -f ~/.aux-credentials
AUX_SERVER_URL=ws://localhost:7700 npx tsx packages/daemon/bin/auxd.ts &
sleep 2
# Server terminal should show auth event for guest_xxxx
npx tsx packages/client/bin/aux.ts quit
npx tsx packages/client/bin/aux.ts login alice alice123   # restore
```

---

## Rooms

**Create named room**
```bash
npx tsx packages/client/bin/aux.ts create lounge
# Expected: Room: lounge (members: alice)
```

**Join existing room** (register Bob first if needed)
```bash
npx tsx packages/client/bin/aux.ts register bob bob123 2>/dev/null || true
AUX_SERVER_CREDS=bob npx tsx packages/client/bin/aux.ts join lounge
# Or via wscat:
npx wscat -c ws://localhost:7700
# send: {"event":"auth","action":"login","username":"bob","password":"bob123"}
# send: {"event":"room:join","name":"lounge"}
# Expected: state:sync with members: [alice, bob]
```

**Duplicate room name rejected**
```bash
npx tsx packages/client/bin/aux.ts create lounge
# Expected: error (ROOM_EXISTS or NAME_TAKEN), exit 1
```

**Host transfer when creator leaves** (wscat, two sessions)
```bash
# Session A — alice
npx wscat -c ws://localhost:7700
# {"event":"auth","action":"login","username":"alice","password":"alice123"}
# {"event":"room:create","name":"transfer-test"}
# note hostId in response

# Session B — bob (new terminal)
npx wscat -c ws://localhost:7700
# {"event":"auth","action":"login","username":"bob","password":"bob123"}
# {"event":"room:join","name":"transfer-test"}

# Back in Session A — disconnect (Ctrl+C)
# Session B receives state:sync with new hostId = bob's ID
```

---

## TUI

**aux (no args) auto-spawns daemon**
```bash
npx tsx packages/client/bin/aux.ts
# Expected: TUI renders within ~5s, /tmp/aux.pid and /tmp/aux.sock exist
ls /tmp/aux.pid /tmp/aux.sock
```

**All four panels render** — **[visual]**
```
Expected: Now Playing · Queue · Members · Friends panels visible
```

**Tab cycles panel focus** — **[visual]**
```
Press Tab repeatedly.
Expected: active panel border cycles Now Playing → Queue → Members → Friends → …
```

**q exits TUI, daemon stays alive**
```bash
# Press q in TUI, then:
kill -0 $(cat /tmp/aux.pid) && echo "daemon alive"
# Expected: daemon alive
```

**Second aux attaches to same daemon**
```bash
# Open a second terminal tab while daemon is running:
npx tsx packages/client/bin/aux.ts
# Expected: TUI renders immediately (no spawn delay), same room state shown
```

**aux quit stops daemon**
```bash
npx tsx packages/client/bin/aux.ts quit
# Expected: Daemon stopped.
ls /tmp/aux.pid 2>&1   # No such file or directory
ls /tmp/aux.sock 2>&1  # No such file or directory
```

---

## Search + Queue

All steps below require the TUI open and a room created.

**s enters search mode** — **[visual]**
```
Press s.
Expected: search overlay appears at top with cursor
```

**Search returns results** — **[visual]**
```
Type: daft punk get lucky
Press Enter.
Expected: numbered results list after ~5-10s (yt-dlp network call)
```

**↑↓ navigates results** — **[visual]**
```
Press ↓ then ↑.
Expected: ▶ highlight moves between results
```

**Enter queues selected track** — **[visual]**
```
Press Enter on a highlighted result.
Expected: overlay closes, track appears in Queue panel
```

**Queue panel shows queued track** — **[visual]**
```
Observe Queue panel after queuing.
Expected: title, duration, username shown
```

**Esc cancels search** — **[visual]**
```
Press s, type something, press Esc.
Expected: overlay closes, no results, mode returns to normal
```

---

## Playback

**First queued track triggers playback** — **[visual + audio]**
```
After queuing first track:
Expected: Now Playing panel shows title/artist, audio starts within ~3s
```

**Progress bar ticks every second** — **[visual]**
```
Observe Now Playing panel.
Expected: elapsed time increments, bar fills
```

**Track title/artist shown in Now Playing** — **[visual]**
```
Expected: title and artist lines populated in Now Playing panel
```

**Next track plays automatically when current ends**
```bash
# Queue two tracks, wait for first to finish (or skip it with x):
# Expected: second track starts within ~1s of first ending,
#           Now Playing updates automatically
```

---

## Skip

**x registers skip vote (single-user room)**
```bash
# In TUI with a track playing and only one member, press x.
# Expected: track skips immediately (1/1 = 100% > 50%)
```

**Single user in room: x skips immediately** — covered above

**Two users: 1 vote shows counter, does not skip**
```bash
# Open wscat session as bob, join the room (2 members total).
npx wscat -c ws://localhost:7700
# {"event":"auth","action":"login","username":"bob","password":"bob123"}
# {"event":"room:join","name":"lounge"}

# Press x in Alice's TUI (1/2 = 50%, not > 50%).
# Expected: TUI shows "1/2 votes to skip", track keeps playing.
# wscat receives state:sync with skipVotes.length === 1
```

**Two users: 2nd vote triggers skip**
```bash
# In the wscat session (Bob):
# {"event":"queue:skip"}
# Expected: 2/2 = 100% > 50% → track skips.
# Both Alice's TUI and wscat receive state:sync / playback:next
```

**Skip votes reset after skip**
```bash
# After skip triggers, inspect state:sync in wscat:
# Expected: "skipVotes":[] in the room object
```

---

## Guest Mode

**Join without credentials gets guest_xxxx username**
```bash
npx wscat -c ws://localhost:7700
# {"event":"auth","action":"guest"}
# Expected: {"event":"auth:ok","username":"guest_xxxx",...}
# No "token" field (or token is a short-lived guest token, not a saved JWT)
```

**Guest can queue tracks**
```bash
# After guest auth and room:join:
# {"event":"room:join","name":"lounge"}
# {"event":"queue:add","youtubeUrl":"https://www.youtube.com/watch?v=5NV6Rdv1a3I","title":"Guest Track","artist":"Guest Artist","duration":120}
# Expected: Alice's TUI Queue panel updates with Guest Track
```

**create command rejected for guest**
```bash
# {"event":"room:create","name":"shouldfail"}
# Expected: {"event":"room:error","code":"GUESTS_CANNOT_CREATE_ROOMS"}

# Or via CLI (no credentials):
HOME=/tmp/smoke-guest npx tsx packages/client/bin/aux.ts create newroom
# Expected: "Guests cannot create rooms. Register first: ..."
```

**Guest disappears from members on disconnect**
```bash
# Ctrl+C the wscat guest session.
# Expected: Alice's TUI Members panel drops the guest entry within a few seconds
# (next state:sync — observe visually or check raw wscat: no guest in members array)
```

---

## Friends

**aux friend add \<username\> adds friend**
```bash
npx tsx packages/client/bin/aux.ts friend add bob
# Expected (bob offline): Added bob as a friend.
# Expected (bob online):  Added bob as a friend. They are online in room: <roomname>.
```

**Friends panel shows offline friend with ○** — **[visual]**
```bash
npx tsx packages/client/bin/aux.ts   # open TUI, Tab to Friends panel
# Expected: bob  ○
```

**Online friend shows ● and room name** — **[visual]**
```bash
# In wscat (bob):
# {"event":"auth","action":"login","username":"bob","password":"bob123"}
# {"event":"room:join","name":"lounge"}
# Watch Alice's Friends panel.
# Expected: bob ● lounge
```

**Enter in Friends panel joins friend's room** — **[visual]**
```
Navigate Friends panel to Bob's entry, press Enter.
Expected: Alice joins Bob's room. Members panel shows both. Header shows room: lounge.
```

---

## Spotify Import

**p with no SPOTIFY_CLIENT_ID shows error** — **[visual]**
```bash
npx tsx packages/client/bin/aux.ts   # no SPOTIFY_CLIENT_ID in env
# Press p in TUI.
# Expected: yellow status message:
#   "Set SPOTIFY_CLIENT_ID env var. Create an app at https://developer.spotify.com/dashboard"
```

**p with client ID starts OAuth flow** — **[visual]**
```bash
aux quit
SPOTIFY_CLIENT_ID=<your-client-id> npx tsx packages/client/bin/aux.ts
# Press p.
# Expected: TUI shows "Opening Spotify auth in browser..." with URL
```

**Auth URL shown in TUI** — **[visual]**
```
Expected: full https://accounts.spotify.com/... URL printed in TUI if browser does not open
```

**Playlist browser renders after auth** — **[visual]**
```
Complete OAuth in browser.
Expected: list of playlists with track counts, ↑↓ navigation, Enter to import
```

**Import progress updates in real time** — **[visual]**
```
Press Enter on a playlist.
Expected: "Resolved: N / total" counter increments as each track is matched
```

**Queued tracks appear in Queue panel** — **[visual]**
```
After import completes.
Expected: Queue panel populated with resolved tracks; status bar shows "N queued, M failed"
```

**Esc cancels in-progress import** — **[visual]**
```
Start importing a large playlist (20+ tracks), press Esc mid-import.
Expected: TUI returns to normal immediately; no further queue:add events sent
```

---

## Automated harness (covers Scenarios 2c/2d, 4–8 in one shot)

```bash
# Server must be running on :7700 before executing
node scripts/smoke-ws.mjs
# Expected: 37 passed, 0 failed
```
