import { describe, expect, it } from 'vitest';

import { DEFAULT_THEME, paletteFor, themeNames } from '../theme-palette';

const SPA_THEMES = ['hydra-dark', 'yellow', 'blue', 'green', 'pink', 'hydra-light', 'solarized-light'];

describe('theme palettes read from the lab-web stylesheet', () => {
  it('exposes every theme the control center offers', () => {
    expect(themeNames()).toEqual(expect.arrayContaining(SPA_THEMES));
  });

  it.each(SPA_THEMES)('resolves every %s token to a literal value', (theme) => {
    const unresolved = Object.entries(paletteFor(theme)).filter(
      ([, value]) => value.length === 0 || value.includes('var('),
    );
    expect(unresolved).toEqual([]);
  });

  it('maps the tokens the docs care about', () => {
    expect(paletteFor('hydra-dark')).toMatchObject({
      bg: '#0c0a17',
      bgSecondary: '#141120',
      accent: '#eceaff',
      border: '#2e2a42',
      statusOnline: '#6fec4f',
      font: "'JetBrains Mono', monospace",
    });
    expect(paletteFor('solarized-light')).toMatchObject({ accent: '#2aa198', bg: '#f8f5f0' });
  });

  it('inherits the base tokens a theme does not override', () => {
    expect(paletteFor('blue')).toMatchObject({ accent: '#6bc1ff', bg: '#0c0a17' });
  });

  it('takes the light-theme status colors from the stylesheet', () => {
    expect(paletteFor('hydra-light')).toMatchObject({ statusOnline: '#15803d', statusInfo: '#2563eb' });
  });

  it.each([undefined, 'not-a-theme'])('falls back to the default theme for %s', (theme) => {
    expect(paletteFor(theme)).toEqual(paletteFor(DEFAULT_THEME));
  });

  it('keeps a distinct code-sample background per theme family', () => {
    expect(paletteFor('hydra-dark').codeBg).toBe('#08061a');
    expect(paletteFor('yellow').codeBg).toBe('#0a0705');
    expect(paletteFor('solarized-light').codeBg).toBe('#e2dfd9');
  });
});
