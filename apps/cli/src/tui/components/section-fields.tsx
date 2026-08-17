import { Box, Text } from 'ink';
import React from 'react';

interface SectionFieldsProps {
  title: string;
  fields: { label: string; value: string }[];
}

export function SectionFields({ title, fields }: SectionFieldsProps) {
  if (fields.length === 0) return null;

  const maxLabelLen = fields.reduce((max, f) => Math.max(max, f.label.length), 0);

  return (
    <>
      <Box marginTop={1} marginBottom={0}>
        <Text bold color="cyan">
          {title}
        </Text>
      </Box>
      {fields.map((f, i) => (
        <Box key={`${title}-${i}`}>
          <Box width={maxLabelLen + 2}>
            <Text>{f.label}:</Text>
          </Box>
          {f.value && <Text>{f.value}</Text>}
        </Box>
      ))}
    </>
  );
}
