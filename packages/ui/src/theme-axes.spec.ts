import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { THEME_COLORS, THEME_STYLES } from './components/theme-provider';
import { THEME_COLOR_VALUES, THEME_STYLE_VALUES } from './lib/theme-axes';

const stylesDir = join(dirname(fileURLToPath(import.meta.url)), 'styles');
const css = (name: string) => readFileSync(join(stylesDir, name), 'utf8');

const themeBase = css('theme-base.css');
const modes = css('modes.css');
const colors = css('colors.css');
const styleRetro = css('style-retro.css');
const styleModern = css('style-modern.css');
const allStyles = [
  themeBase,
  modes,
  colors,
  styleRetro,
  styleModern,
  css('brokkr.css'),
  css('base.css'),
  css('terminal-theme.css'),
  css('fonts.css'),
];

const STYLE_TOKENS = [
  '--color-bg-primary',
  '--color-bg-secondary',
  '--color-bg-sidebar',
  '--color-bg-sidebar-alt',
  '--color-text-primary',
  '--color-text-muted',
  '--color-text-dim',
  '--color-text-label',
  '--color-border',
  '--color-border-dim',
  '--color-active-bg',
  '--color-hover-bg',
  '--color-sidebar-section-bg',
  '--color-status-online',
  '--color-status-offline',
  '--color-status-warning',
  '--color-input-border',
  '--color-input-background',
  '--font-mono',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--radius-xl',
  '--radius-2xl',
  '--radius-3xl',
];

const BASE_TOKENS = [
  '--color-bg-primary',
  '--color-bg-secondary',
  '--color-bg-sidebar',
  '--color-bg-sidebar-alt',
  '--color-accent',
  '--color-accent-dim',
  '--color-accent-glow',
  '--color-accent-foreground',
  '--color-text-primary',
  '--color-text-muted',
  '--color-text-dim',
  '--color-text-label',
  '--color-border',
  '--color-border-dim',
  '--color-status-online',
  '--color-status-offline',
  '--color-status-warning',
  '--color-status-price',
  '--color-status-info',
  '--color-status-purple',
  '--color-glow-cyan',
  '--color-glow-cyan-light',
  '--color-active-bg',
  '--color-active-bar',
  '--color-hover-bg',
  '--color-logo-bg',
  '--font-mono',
  '--radius-none',
  '--radius-sm',
  '--radius-md',
  '--radius-lg',
  '--radius-xl',
  '--radius-2xl',
  '--radius-3xl',
  '--color-background',
  '--color-foreground',
  '--color-primary',
  '--color-primary-foreground',
  '--color-secondary',
  '--color-secondary-foreground',
  '--color-destructive',
  '--color-destructive-foreground',
  '--color-muted',
  '--color-muted-foreground',
  '--color-popover',
  '--color-popover-foreground',
  '--color-card',
  '--color-card-foreground',
  '--color-sidebar',
  '--color-sidebar-foreground',
  '--color-sidebar-primary',
  '--color-sidebar-primary-foreground',
  '--color-sidebar-accent',
  '--color-sidebar-accent-foreground',
  '--color-sidebar-border',
  '--color-sidebar-ring',
  '--color-sidebar-hover',
  '--color-input',
  '--color-ring',
  '--spacing',
  '--color-chart-1',
  '--color-chart-2',
  '--color-chart-3',
  '--color-chart-4',
  '--color-chart-5',
  '--color-chart-6',
  '--color-chart-7',
  '--color-chart-8',
  '--color-chart-9',
  '--color-chart-10',
  '--color-table-header',
  '--color-table-body',
  '--color-input-border',
  '--color-input-background',
  '--color-input-foreground',
  '--color-input-placeholder',
  '--color-input-error',
  '--color-tabs-active',
];

const SEEDS = ['--seed-accent-strong', '--seed-accent', '--seed-accent-deep'];

function blockFor(source: string, selector: string): string {
  const start = source.indexOf(selector);
  expect(start, `selector ${selector} not found`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf('{', start);
  const close = source.indexOf('}', open);
  return source.slice(open + 1, close);
}

describe('theme axes CSS', () => {
  it('declares every base token in @theme', () => {
    for (const token of BASE_TOKENS) {
      expect(themeBase, `missing ${token} in theme-base.css`).toContain(`${token}:`);
    }
  });

  it('has a seed block per THEME_COLORS entry', () => {
    for (const color of THEME_COLORS) {
      const block = blockFor(colors, `[data-color='${color.value}']`);
      for (const seed of SEEDS) {
        expect(block, `missing ${seed} for ${color.value}`).toContain(`${seed}:`);
      }
    }
  });

  it('lists every canonical color once', () => {
    expect(THEME_COLORS.map((c) => c.value)).toEqual(THEME_COLOR_VALUES);
  });

  it('has no data-color block outside THEME_COLORS', () => {
    const declared = [...colors.matchAll(/\[data-color='([a-z-]+)'\]/g)].map((m) => m[1]);
    const known = new Set<string>(THEME_COLOR_VALUES);
    for (const value of declared) {
      expect(known.has(value), `unknown data-color block '${value}'`).toBe(true);
    }
  });

  it('defines both style blocks with the same style-scoped tokens', () => {
    expect(THEME_STYLES.map((s) => s.value)).toEqual(THEME_STYLE_VALUES);
    const retroBlock = blockFor(styleRetro, "[data-style='retro']");
    const modernBlock = blockFor(styleModern, "[data-style='modern']");
    for (const token of STYLE_TOKENS) {
      expect(retroBlock, `missing ${token} in style-retro.css`).toContain(`${token}:`);
      expect(modernBlock, `missing ${token} in style-modern.css`).toContain(`${token}:`);
    }
  });

  it('defines both modes via color-scheme', () => {
    expect(blockFor(modes, "[data-mode='dark']")).toContain('color-scheme: dark');
    expect(blockFor(modes, "[data-mode='light']")).toContain('color-scheme: light');
  });

  it('contains no legacy data-theme or data-preset selectors', () => {
    for (const source of allStyles) {
      expect(source).not.toMatch(/\[data-theme=/);
      expect(source).not.toMatch(/\[data-preset=/);
    }
  });
});
