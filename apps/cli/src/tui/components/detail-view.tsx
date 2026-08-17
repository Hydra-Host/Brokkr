import { Box, Text } from 'ink';
import React from 'react';
import { useBackQuitKeys } from '../hooks.js';

interface Field {
  label: string;
  value: string;
}

interface DetailContentProps {
  title: string;
  subtitle?: string;
  fields: Field[];
  children?: React.ReactNode;
}

export function DetailContent({ title, subtitle, fields, children }: DetailContentProps) {
  const maxLabelLen = fields.reduce((max, f) => Math.max(max, f.label.length), 0);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold>{title}</Text>
        {subtitle && <Text> {subtitle}</Text>}
      </Box>

      {fields.map((f) => (
        <Box key={f.label}>
          <Box width={maxLabelLen + 2}>
            <Text>{f.label}:</Text>
          </Box>
          <Text>{f.value}</Text>
        </Box>
      ))}

      {children && (
        <Box marginTop={1} flexDirection="column">
          {children}
        </Box>
      )}
    </Box>
  );
}

interface DetailViewProps extends DetailContentProps {
  onBack?: () => void;
}

export function DetailView({ onBack, ...props }: DetailViewProps) {
  useBackQuitKeys(onBack);

  return (
    <Box flexDirection="column">
      <DetailContent {...props} />
      <Box paddingX={1} marginTop={1}>
        <Text>esc back q quit</Text>
      </Box>
    </Box>
  );
}
