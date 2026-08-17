import { Box, Text } from 'ink';
import React from 'react';
import { useBackQuitKeys } from '../hooks.js';

interface ErrorViewProps {
  message: string;
  onBack?: () => void;
}

export function ErrorView({ message, onBack }: ErrorViewProps) {
  useBackQuitKeys(onBack);

  return (
    <Box flexDirection="column" paddingX={2}>
      <Text color="red">{message}</Text>
      <Box marginTop={1}>
        <Text>{onBack ? 'esc back  ·  q quit' : 'q quit'}</Text>
      </Box>
    </Box>
  );
}
