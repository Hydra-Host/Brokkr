import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { THEME_COLORS, ThemeProvider } from './theme-provider';
import { ThemeSettingsPanel } from './theme-settings-panel';

const host = document.createElement('div');
const root = createRoot(host);
const html = document.documentElement;

function group(label: string) {
  return host.querySelector(`[role="group"][aria-label="${label}"]`)!;
}

function pressed(label: string) {
  return [...group(label).querySelectorAll('button')].flatMap((button, index) =>
    button.getAttribute('aria-pressed') === 'true' ? [index] : [],
  );
}

function click(label: string, index: number) {
  act(() => group(label).querySelectorAll('button')[index].click());
}

beforeEach(() => {
  localStorage.clear();
  act(() =>
    root.render(
      <ThemeProvider defaultStyle="retro" defaultColor="violet" defaultMode="dark">
        <ThemeSettingsPanel />
      </ThemeProvider>,
    ),
  );
});

afterEach(() => act(() => root.render(null)));

describe('ThemeSettingsPanel', () => {
  it('marks the current selection on every axis (dark, retro, violet)', () => {
    expect(pressed('Mode')).toEqual([1]);
    expect(pressed('Style')).toEqual([0]);
    expect(pressed('Color')).toEqual([0]);
  });

  it('switches mode and reflects it on <html>', () => {
    click('Mode', 0);
    expect(pressed('Mode')).toEqual([0]);
    expect(html.getAttribute('data-mode')).toBe('light');
    expect(localStorage.getItem('brokkr-mode')).toBe('light');
  });

  it('switches style', () => {
    click('Style', 1);
    expect(pressed('Style')).toEqual([1]);
    expect(html.getAttribute('data-style')).toBe('modern');
  });

  it('switches color', () => {
    click('Color', 2);
    expect(pressed('Color')).toEqual([2]);
    expect(html.getAttribute('data-color')).toBe(THEME_COLORS[2].value);
  });
});
