import { beforeEach, describe, expect, it } from 'vitest';

import { buildRedfishConfig, getRedfishConfig, resetOobConfigForTests } from '../oob.config.js';

describe('Redfish config', () => {
  beforeEach(() => {
    resetOobConfigForTests();
  });

  it('defaults timeout to 30', () => {
    const config = buildRedfishConfig();
    expect(config.timeout).toBe(30);
  });

  it('defaults content type to application/json', () => {
    const config = buildRedfishConfig();
    expect(config.defaultContentType).toBe('application/json');
  });

  it('returns a cached singleton across getRedfishConfig calls', () => {
    const first = getRedfishConfig();
    const second = getRedfishConfig();
    expect(first).toBe(second);
  });

  it('refreshes the singleton after resetOobConfigForTests', () => {
    const first = getRedfishConfig();
    resetOobConfigForTests();
    const second = getRedfishConfig();
    expect(first).not.toBe(second);
  });
});
