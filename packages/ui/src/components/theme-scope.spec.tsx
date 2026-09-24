import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { ThemeScope } from './theme-scope';

const host = document.createElement('div');
const root = createRoot(host);

afterEach(() => act(() => root.render(null)));

describe('ThemeScope', () => {
  it('pins the full axis triple on the wrapper', () => {
    act(() =>
      root.render(
        <ThemeScope style="modern" color="blue" mode="light" className="x">
          <span>child</span>
        </ThemeScope>,
      ),
    );
    const wrapper = host.firstElementChild!;
    expect(wrapper.getAttribute('data-style')).toBe('modern');
    expect(wrapper.getAttribute('data-color')).toBe('blue');
    expect(wrapper.getAttribute('data-mode')).toBe('light');
    expect(wrapper.className).toBe('x');
    expect(wrapper.textContent).toBe('child');
  });

  it('lets the pinned axes win over spread props', () => {
    const leaked = { 'data-mode': 'dark' } as Record<string, string>;
    act(() => root.render(<ThemeScope style="retro" color="gold" mode="light" {...leaked} />));
    expect(host.firstElementChild!.getAttribute('data-mode')).toBe('light');
  });
});
