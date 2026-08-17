import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function Loading({ message = 'Loading...' }: { message?: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return (
    <Box paddingX={2}>
      <Text color="cyan">{FRAMES[frame]} </Text>
      <Text>{message}</Text>
    </Box>
  );
}
