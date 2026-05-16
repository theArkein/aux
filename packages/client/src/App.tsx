import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { createIpcClient } from './ipc-client.js';

type PanelId = 'nowPlaying' | 'queue' | 'members';
const PANELS: PanelId[] = ['nowPlaying', 'queue', 'members'];

interface Member { id: string; username: string; }
interface QueueTrack { id: string; title: string; queuedBy: string; }
interface RoomState { name: string; members: Member[]; queue: QueueTrack[]; }

interface PanelBoxProps {
  title: string;
  focused: boolean;
  children: React.ReactNode;
}

function PanelBox({ title, focused, children }: PanelBoxProps): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={focused ? 'cyan' : 'gray'} paddingX={1} width={30} minHeight={10}>
      <Text bold color={focused ? 'cyan' : undefined}>{title}</Text>
      <Box marginTop={1} flexDirection="column">{children}</Box>
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
          {room ? <Text dimColor>Nothing playing yet</Text> : <Text dimColor>Not in a room</Text>}
        </PanelBox>
        <PanelBox title="Queue" focused={focused === 'queue'}>
          {room && room.queue.length > 0 ? room.queue.map((t) => <Text key={t.id}>{t.title}</Text>) : <Text dimColor>Queue is empty</Text>}
        </PanelBox>
        <PanelBox title="Members" focused={focused === 'members'}>
          {room && room.members.length > 0 ? room.members.map((m) => <Text key={m.id}>{m.username}</Text>) : <Text dimColor>No members</Text>}
        </PanelBox>
      </Box>
      <Box marginTop={1}><Text dimColor>Tab: switch panel  ·  q: quit TUI</Text></Box>
    </Box>
  );
}
