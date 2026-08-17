import { renderToString } from 'ink';
import React from 'react';

export function renderOnce(element: React.ReactElement): void {
  const output = renderToString(element, {
    columns: process.stdout.columns || 120,
  });
  console.log(output);
}
