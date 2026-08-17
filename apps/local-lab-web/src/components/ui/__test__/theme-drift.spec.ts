import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { THEME_OPTIONS } from '../theme';

const cssPath = fileURLToPath(new URL('../../../styles/brokkr-theme.css', import.meta.url));
const css = readFileSync(cssPath, 'utf8');

const blockRe = /^\[data-theme='([^']+)'\]\s*\{([^}]*)\}/gm;

const cssThemes = new Map<string, string>();
for (const match of css.matchAll(blockRe)) {
  const [, name, body] = match;
  cssThemes.set(name, body);
}

describe('THEME_OPTIONS drift guard (brokkr-theme.css)', () => {
  it('parses at least one data-theme block (parser sanity)', () => {
    expect(cssThemes.size).toBeGreaterThan(0);
  });

  it('has no duplicate ids in THEME_OPTIONS', () => {
    const ids = THEME_OPTIONS.map((t) => t.value);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('THEME_OPTIONS ids exactly match the data-theme blocks in the css', () => {
    const fromCss = [...cssThemes.keys()].sort();
    const fromOptions = THEME_OPTIONS.map((t) => t.value).sort();
    expect(fromOptions).toEqual(fromCss);
  });

  it.each(THEME_OPTIONS.map((t) => [t.value, t.color] as const))(
    "swatch for '%s' matches the theme's --color-accent",
    (value, color) => {
      const body = cssThemes.get(value);
      expect(body).toBeDefined();
      const accent = body?.match(/--color-accent:\s*(#[0-9a-fA-F]{3,8})\s*;/)?.[1];
      expect(accent, `--color-accent not found in [data-theme='${value}']`).toBeDefined();
      expect(color.toLowerCase()).toBe(accent?.toLowerCase());
    },
  );
});
