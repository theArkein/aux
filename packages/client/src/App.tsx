import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { createIpcClient, type IpcClientHandle } from './ipc-client.js';

type PanelId = 'nowPlaying' | 'queue' | 'members';
const PANELS: PanelId[] = ['nowPlaying', 'queue', 'members'];

interface Member { id: string; username: string; }

interface Track {
  id: string;
  title: string;
  artist: string;
  duration: number;
  queuedBy: string;
}

interface RoomState { name: string; members: Member[]; queue: Track[]; }

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
          setRoom(m['room'] as RoomState);
        }
        if (m['event'] === 'queue:update' && Array.isArray(m['queue'])) {
          setRoom((prev) => prev ? { ...prev, queue: m['queue'] as Track[] } : prev);
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
              {room ? <Text dimColor>Nothing playing yet</Text> : <Text dimColor>Not in a room</Text>}
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
                ? room.members.map((m) => <Text key={m.id}>{m.username}</Text>)
                : <Text dimColor>No members</Text>}
            </PanelBox>
          </Box>
          <Box marginTop={1}><Text dimColor>Tab: switch panel  ·  s: search  ·  q: quit TUI</Text></Box>
        </>
      )}
    </Box>
  );
}
