import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { LEGACY_THEME_AXES } from './components/theme-provider';
import { THEME_COLOR_VALUES, THEME_MODE_VALUES, THEME_STYLE_VALUES } from './lib/theme-axes';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'theme-init.js'), 'utf8');

function literal<T>(name: string): T {
  const match = source.match(new RegExp(`var ${name} = ([^;]+);`));
  expect(match, `var ${name} not found in theme-init.js`).not.toBeNull();
  return new Function(`return ${match![1]}`)();
}

describe('theme-init.js mirrors the provider tables', () => {
  it('has the same legacy theme map as LEGACY_THEME_AXES', () => {
    const expected = Object.fromEntries(
      Object.entries(LEGACY_THEME_AXES).map(([id, axes]) => [id, [axes.style, axes.color, axes.mode]]),
    );
    expect(literal<Record<string, string[]>>('LEGACY')).toEqual(expected);
  });

  it('has the same axis value lists as theme-axes.ts', () => {
    expect(literal<string[]>('STYLES')).toEqual([...THEME_STYLE_VALUES]);
    expect(literal<string[]>('COLORS')).toEqual([...THEME_COLOR_VALUES]);
    expect(literal<string[]>('MODES')).toEqual([...THEME_MODE_VALUES]);
  });
});
