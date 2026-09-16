import { describe, expect, it } from 'vitest';

import { REACT_SINGLETON_DEDUPE } from '../dedupe.js';

describe('REACT_SINGLETON_DEDUPE', () => {
  it('pins react, the router and both query clients', () => {
    expect(REACT_SINGLETON_DEDUPE).toEqual([
      'react',
      'react-dom',
      '@tanstack/react-router',
      '@tanstack/react-query',
      '@ts-rest/react-query',
    ]);
  });

  it('holds no duplicate', () => {
    expect(new Set(REACT_SINGLETON_DEDUPE).size).toBe(REACT_SINGLETON_DEDUPE.length);
  });
});
