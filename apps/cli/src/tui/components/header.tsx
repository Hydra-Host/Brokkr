import { Box, Text } from 'ink';
import React from 'react';
import { useRouter } from '../router.js';

interface HeaderProps {
  env: string;
  orgName: string;
}

export function Header({ env, orgName }: HeaderProps) {
  const { stack } = useRouter();
  const breadcrumb = stack.map((r) => r.title ?? r.screen).join(' > ');

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box>
        <Text bold color="cyan">
          Brokkr
        </Text>
        <Text>
          {' '}
          · {orgName} · {env}
        </Text>
      </Box>
      <Box>
        <Text>{breadcrumb}</Text>
      </Box>
    </Box>
  );
}
