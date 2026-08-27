import { describe, expect, it } from 'vitest';
import { formatCspSources, mergePluginCsp } from '@hydrahost/plugin-sdk';

describe('mergePluginCsp', () => {
  it('unions sources from enabled plugins without duplicating tokens', () => {
    const merged = mergePluginCsp([
      { scriptSrc: ['https://a.example', 'https://b.example'], imgSrc: ['https://img.example'] },
      { scriptSrc: ['https://b.example', 'https://c.example'], connectSrc: ['https://api.example'] },
      undefined,
    ]);

    expect(merged.scriptSrc).toEqual(['https://a.example', 'https://b.example', 'https://c.example']);
    expect(merged.imgSrc).toEqual(['https://img.example']);
    expect(merged.connectSrc).toEqual(['https://api.example']);
    expect(merged.workerSrc).toEqual([]);
  });

  it('formats an empty directive as an empty suffix', () => {
    expect(formatCspSources([])).toBe('');
    expect(formatCspSources(['https://a.example', "'wasm-unsafe-eval'"])).toBe(
      " https://a.example 'wasm-unsafe-eval'",
    );
  });
});
