import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const SOURCE = z
  .record(z.string(), z.string())
  .parse(import.meta.glob('../**/*.tsx', { query: '?raw', import: 'default', eager: true }));

const APP_SOURCE = Object.entries(SOURCE).filter(([path]) => !path.includes('.spec.'));

const shell = () => {
  const found = APP_SOURCE.find(([path]) => path === '../routes/__root.tsx');
  if (!found) throw new Error('../routes/__root.tsx is not in the raw-source glob');
  return found[1];
};

describe('shell scroll containment', () => {
  it('bounds the shell row to the viewport', () => {
    expect(shell()).toContain('h-dvh');
  });

  it('never lets the shell row grow past the viewport', () => {
    expect(shell()).not.toContain('min-h-screen');
  });

  it('keeps the page scroller bounded by an overflow-hidden parent', () => {
    expect(shell()).toContain('flex-1 overflow-hidden');
    expect(shell()).toContain('h-full overflow-y-auto');
  });

  it('pins no page to a hand-measured viewport offset', () => {
    const offenders = APP_SOURCE.filter(([, text]) => /calc\(100dvh|calc\(100vh/.test(text)).map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
