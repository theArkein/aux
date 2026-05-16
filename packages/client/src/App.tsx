import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { createIpcClient, type IpcClientHandle } from './ipc-client.js';

type PanelId = 'nowPlaying' | 'queue' | 'members';
const PANELS: PanelId[] = ['nowPlaying', 'queue', 'members'];

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

type Mode = 'normal' | 'typing' | 'results';

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
  });

  const searchOverlay = mode === 'typing' || mode === 'results';
  const clampedElapsed = playback ? Math.min(elapsed, playback.track.duration) : 0;

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold>aux</Text>
        {room && <Text dimColor>  room: {room.name}</Text>}
      </Box>

      {searchOverlay ? (
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
      ) : (
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
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Tab: switch panel  ·  s: search  ·  x: skip  ·  +/-: volume  ·  q: quit TUI</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
