import { afterEach, describe, expect, it } from 'vitest';

import { buildRedfishConfig, getRedfishConfig, resetOobConfigForTests } from '../oob.config';

afterEach(() => {
  resetOobConfigForTests();
});

describe('buildRedfishConfig', () => {
  it('defaults timeout to 30 and content type to application/json', () => {
    const cfg = buildRedfishConfig();
    expect(cfg.timeout).toBe(30);
    expect(cfg.defaultContentType).toBe('application/json');
  });
});

describe('singleton getters', () => {
  it('getRedfishConfig caches', () => {
    const a = getRedfishConfig();
    const b = getRedfishConfig();
    expect(a).toBe(b);
  });
});
