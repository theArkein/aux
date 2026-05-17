import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { createIpcClient, type IpcClientHandle } from './ipc-client.js';

type PanelId = 'nowPlaying' | 'queue' | 'members' | 'friends';
const PANELS: PanelId[] = ['nowPlaying', 'queue', 'members', 'friends'];

interface Member { id: string; username: string; isGuest?: boolean; }

interface Track {
  id: string;
  title: string;
  artist: string;
  duration: number;
  queuedBy: string;
}

interface RoomState {
  name: string;
  members: Member[];
  queue: Track[];
  nowPlaying: Track | null;
  playbackStartedAt: number | null;
  skipVotes: string[];
}

interface PlaybackState {
  track: Track;
  startAt: number;
}

interface SearchResult {
  title: string;
  artist: string;
  duration: number;
  youtubeUrl: string;
}

interface FriendPresence {
  id: string;
  username: string;
  status: 'online' | 'offline';
  roomName: string | null;
}

interface SpotifyPlaylist {
  id: string;
  name: string;
  trackCount: number;
}

interface SpotifyProgress {
  resolved: number;
  total: number;
  failed: number;
}

type Mode = 'normal' | 'typing' | 'results' | 'spotify-loading' | 'spotify-playlists' | 'spotify-importing';

interface PanelBoxProps {
  title: string;
  focused: boolean;
  children: React.ReactNode;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function progressBar(elapsed: number, duration: number, width = 20): string {
  const ratio = duration > 0 ? Math.min(1, elapsed / duration) : 0;
  const filled = Math.floor(ratio * width);
  return '='.repeat(filled) + ' '.repeat(width - filled);
}

function PanelBox({ title, focused, children }: PanelBoxProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? 'cyan' : 'gray'} paddingX={1} width={34} minHeight={10}>
      <Text bold color={focused ? 'cyan' : undefined}>{title}</Text>
      <Box marginTop={1} flexDirection="column">{children}</Box>
    </Box>
  );
}

export default function App(): React.ReactElement {
  const { exit } = useApp();
  const [focused, setFocused] = useState<PanelId>('nowPlaying');
  const [room, setRoom] = useState<RoomState | null>(null);
  const [playback, setPlayback] = useState<PlaybackState | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [mode, setMode] = useState<Mode>('normal');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [friends, setFriends] = useState<FriendPresence[]>([]);
  const [selectedFriendIdx, setSelectedFriendIdx] = useState(0);
  const [spotifyPlaylists, setSpotifyPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [selectedPlaylistIdx, setSelectedPlaylistIdx] = useState(0);
  const [spotifyAuthUrl, setSpotifyAuthUrl] = useState<string | null>(null);
  const [spotifyProgress, setSpotifyProgress] = useState<SpotifyProgress | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const clientRef = useRef<IpcClientHandle | null>(null);

  useEffect(() => {
    const client = createIpcClient({
      onMessage(msg) {
        const m = msg as Record<string, unknown>;

        if (m['event'] === 'state:sync' && m['room']) {
          const r = m['room'] as RoomState;
          setRoom(r);
          if (r.nowPlaying && r.playbackStartedAt) {
            const startAt = r.playbackStartedAt;
            setPlayback({ track: r.nowPlaying, startAt });
            setElapsed(Math.max(0, Math.floor((Date.now() - startAt) / 1000)));
          }
        }

        if (m['event'] === 'queue:update' && Array.isArray(m['queue'])) {
          setRoom((prev) => prev ? { ...prev, queue: m['queue'] as Track[] } : prev);
        }

        if (m['event'] === 'playback:next') {
          const track = m['track'];
          const startAt = Number(m['startAt']);
          if (!track || typeof track !== 'object' || !Number.isFinite(startAt)) return;
          const typedTrack = track as Track;
          setPlayback({ track: typedTrack, startAt });
          setElapsed(0);
          setRoom((prev) => prev ? { ...prev, nowPlaying: typedTrack } : prev);
        }

        if (m['event'] === 'search:results' && Array.isArray(m['results'])) {
          setResults(m['results'] as SearchResult[]);
          setSelectedIdx(0);
          setMode('results');
        }

        if (m['event'] === 'search:error') {
          setMode('normal');
          setQuery('');
        }

        if (m['event'] === 'friends:list' && Array.isArray(m['friends'])) {
          setFriends(m['friends'] as FriendPresence[]);
        }

        if (m['event'] === 'spotify:auth:url') {
          setSpotifyAuthUrl(String(m['url'] ?? ''));
          setMode('spotify-loading');
        }

        if (m['event'] === 'spotify:auth:ok') {
          setSpotifyAuthUrl(null);
        }

        if (m['event'] === 'spotify:playlists' && Array.isArray(m['playlists'])) {
          setSpotifyPlaylists(m['playlists'] as SpotifyPlaylist[]);
          setSelectedPlaylistIdx(0);
          setMode('spotify-playlists');
        }

        if (m['event'] === 'spotify:import:progress') {
          setSpotifyProgress({
            resolved: Number(m['resolved']),
            total: Number(m['total']),
            failed: Number(m['failed']),
          });
          setMode('spotify-importing');
        }

        if (m['event'] === 'spotify:import:done') {
          setSpotifyProgress(null);
          setMode('normal');
          setStatusMsg(`Spotify import: ${Number(m['queued'])} queued, ${Number(m['failed'])} failed`);
        }

        if (m['event'] === 'spotify:error') {
          setMode('normal');
          setStatusMsg(String(m['message'] ?? m['code'] ?? 'Spotify error'));
        }
      },
      onEnd: exit,
      onError: (err) => { process.stderr.write(err.message + '\n'); exit(); },
    });
    clientRef.current = client;
    return () => { client.close(); };
  }, [exit]);

  useEffect(() => {
    if (!playback) { setElapsed(0); return; }
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - playback.startAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [playback]);

  useEffect(() => {
    setSelectedFriendIdx((i) => Math.min(i, Math.max(0, friends.length - 1)));
  }, [friends]);

  useInput((input, key) => {
    if (mode === 'normal') {
      if (input === 'q') { exit(); return; }
      if (key.tab) {
        const idx = PANELS.indexOf(focused);
        setFocused(PANELS[(idx + 1) % PANELS.length]!);
        return;
      }
      if (input === 's') {
        setQuery('');
        setResults([]);
        setMode('typing');
        return;
      }
      if (input === '+' || input === '=') {
        clientRef.current?.send({ event: 'volume:up' });
        return;
      }
      if (input === '-') {
        clientRef.current?.send({ event: 'volume:down' });
        return;
      }
      if (input === 'x') {
        clientRef.current?.send({ event: 'queue:skip' });
        return;
      }

      if (input === 'p') {
        setSpotifyAuthUrl(null);
        setSpotifyProgress(null);
        setStatusMsg(null);
        setMode('spotify-loading');
        clientRef.current?.send({ event: 'spotify:playlists' });
        return;
      }

      if (focused === 'friends') {
        if (key.upArrow) {
          setSelectedFriendIdx((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedFriendIdx((i) => Math.min(friends.length - 1, i + 1));
          return;
        }
        if (key.return) {
          const friend = friends[selectedFriendIdx];
          if (friend?.roomName) {
            clientRef.current?.send({ event: 'room:join', name: friend.roomName });
          }
          return;
        }
      }
    }

    if (mode === 'typing') {
      if (key.escape) { setMode('normal'); setQuery(''); return; }
      if (key.return) {
        if (query.trim()) {
          clientRef.current?.send({ event: 'search', query: query.trim() });
        }
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setQuery((q) => q + input);
      }
      return;
    }

    if (mode === 'results') {
      if (key.escape) { setMode('normal'); setResults([]); setQuery(''); return; }
      if (key.upArrow) { setSelectedIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setSelectedIdx((i) => Math.min(results.length - 1, i + 1)); return; }
      if (key.return) {
        const track = results[selectedIdx];
        if (track) {
          clientRef.current?.send({
            event: 'queue:add',
            youtubeUrl: track.youtubeUrl,
            title: track.title,
            artist: track.artist,
            duration: track.duration,
          });
          setMode('normal');
          setResults([]);
          setQuery('');
        }
        return;
      }
    }

    if (mode === 'spotify-loading' || mode === 'spotify-importing') {
      if (key.escape) { setMode('normal'); return; }
    }

    if (mode === 'spotify-playlists') {
      if (key.escape) { setMode('normal'); return; }
      if (key.upArrow) { setSelectedPlaylistIdx((i) => Math.max(0, i - 1)); return; }
      if (key.downArrow) {
        setSelectedPlaylistIdx((i) => Math.min(spotifyPlaylists.length - 1, i + 1));
        return;
      }
      if (key.return) {
        const playlist = spotifyPlaylists[selectedPlaylistIdx];
        if (playlist) {
          setSpotifyProgress({ resolved: 0, total: playlist.trackCount, failed: 0 });
          setMode('spotify-importing');
          clientRef.current?.send({ event: 'spotify:import', playlistId: playlist.id });
        }
        return;
      }
    }
  });

  const searchOverlay = mode === 'typing' || mode === 'results';
  const spotifyOverlay = mode === 'spotify-loading' || mode === 'spotify-playlists' || mode === 'spotify-importing';
  const clampedElapsed = playback ? Math.min(elapsed, playback.track.duration) : 0;

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>aux</Text>
        {room && <Text dimColor>  room: {room.name}</Text>}
      </Box>

      {mode === 'spotify-loading' && (
        <Box flexDirection="column">
          {spotifyAuthUrl ? (
            <>
              <Text>Opening Spotify auth in browser...</Text>
              <Text dimColor>If browser did not open, visit:</Text>
              <Text color="cyan">{spotifyAuthUrl}</Text>
            </>
          ) : (
            <Text>Loading Spotify playlists...</Text>
          )}
          <Box marginTop={1}><Text dimColor>Esc: cancel</Text></Box>
        </Box>
      )}

      {mode === 'spotify-playlists' && (
        <Box flexDirection="column">
          <Text bold color="cyan">Spotify Playlists</Text>
          <Box marginTop={1} flexDirection="column">
            {spotifyPlaylists.length === 0
              ? <Text dimColor>No playlists found</Text>
              : spotifyPlaylists.map((pl, i) => (
                  <Box key={pl.id}>
                    <Text color={i === selectedPlaylistIdx ? 'cyan' : undefined}>
                      {i === selectedPlaylistIdx ? '▶ ' : '  '}
                      {pl.name} ({pl.trackCount} tracks)
                    </Text>
                  </Box>
                ))}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>↑↓: navigate  Enter: import playlist  Esc: cancel</Text>
          </Box>
        </Box>
      )}

      {mode === 'spotify-importing' && (
        <Box flexDirection="column">
          <Text bold color="cyan">Importing Spotify playlist...</Text>
          {spotifyProgress && (
            <Box flexDirection="column" marginTop={1}>
              <Text>Resolved: {spotifyProgress.resolved} / {spotifyProgress.total}</Text>
              {spotifyProgress.failed > 0 && (
                <Text color="yellow">Skipped (no YouTube match): {spotifyProgress.failed}</Text>
              )}
            </Box>
          )}
          <Box marginTop={1}><Text dimColor>Esc: cancel</Text></Box>
        </Box>
      )}

      {!spotifyOverlay && searchOverlay && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text bold color="cyan">Search: </Text>
            <Text>{query}{mode === 'typing' ? '█' : ''}</Text>
          </Box>
          {mode === 'results' && results.length === 0 && (
            <Text dimColor>No results</Text>
          )}
          {mode === 'results' && results.map((r, i) => (
            <Box key={r.youtubeUrl}>
              <Text color={i === selectedIdx ? 'cyan' : undefined}>
                {i === selectedIdx ? '▶ ' : '  '}
                {r.title} — {r.artist} ({formatDuration(r.duration)})
              </Text>
            </Box>
          ))}
          <Box marginTop={1}>
            <Text dimColor>
              {mode === 'typing' ? 'Enter: search  Esc: cancel' : '↑↓: navigate  Enter: queue  Esc: cancel'}
            </Text>
          </Box>
        </Box>
      )}

      {!spotifyOverlay && !searchOverlay && (
        <>
          <Box gap={1}>
            <PanelBox title="Now Playing" focused={focused === 'nowPlaying'}>
              {playback ? (
                <Box flexDirection="column">
                  <Text>{playback.track.title}</Text>
                  <Text dimColor>{playback.track.artist}</Text>
                  <Box marginTop={1}>
                    <Text>[{progressBar(clampedElapsed, playback.track.duration)}]</Text>
                  </Box>
                  <Text dimColor>
                    {formatDuration(clampedElapsed)} / {formatDuration(playback.track.duration)}
                  </Text>
                  {room && room.skipVotes.length > 0 && (
                    <Text color="yellow">
                      {room.skipVotes.length}/{room.members.length} votes to skip
                    </Text>
                  )}
                </Box>
              ) : (
                <Text dimColor>{room ? 'Nothing playing' : 'Not in a room'}</Text>
              )}
            </PanelBox>
            <PanelBox title="Queue" focused={focused === 'queue'}>
              {room && room.queue.length > 0
                ? room.queue.map((t) => (
                    <Text key={t.id}>
                      {t.title}
                      {t.duration ? ` (${formatDuration(t.duration)})` : ''}
                      {` · ${t.queuedBy}`}
                    </Text>
                  ))
                : <Text dimColor>Queue is empty</Text>}
            </PanelBox>
            <PanelBox title="Members" focused={focused === 'members'}>
              {room && room.members.length > 0
                ? room.members.map((m) => (
                    <Text key={m.id}>
                      {m.username}{m.isGuest ? <Text dimColor> (guest)</Text> : null}
                    </Text>
                  ))
                : <Text dimColor>No members</Text>}
            </PanelBox>
            <PanelBox title="Friends" focused={focused === 'friends'}>
              {friends.length > 0
                ? friends.map((f, i) => (
                    <Box key={f.id}>
                      <Text color={focused === 'friends' && i === selectedFriendIdx ? 'cyan' : undefined}>
                        {focused === 'friends' && i === selectedFriendIdx ? '▶ ' : '  '}
                        {f.username}
                        {f.status === 'online'
                          ? <Text color="green">{f.roomName ? ` ● ${f.roomName}` : ' ●'}</Text>
                          : <Text dimColor> ○</Text>}
                      </Text>
                    </Box>
                  ))
                : <Text dimColor>No friends</Text>}
            </PanelBox>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>
              {'Tab: switch panel  ·  s: search  ·  p: Spotify import  ·  x: skip  ·  +/-: volume  ·  q: quit TUI'}
              {focused === 'friends' && friends[selectedFriendIdx]?.roomName ? '  ·  Enter: join room' : ''}
            </Text>
            {statusMsg && <Text color="yellow">{statusMsg}</Text>}
          </Box>
        </>
      )}
    </Box>
  );
}
