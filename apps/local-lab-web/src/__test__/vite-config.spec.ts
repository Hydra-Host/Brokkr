import { describe, expect, it } from 'vitest';

import config from '../../vite.config';

describe('local-lab-web vite config', () => {
  it('enforces a host allowlist rather than disabling the check', () => {
    expect(Array.isArray(config.server?.allowedHosts)).toBe(true);
    expect(config.server?.allowedHosts).toContain('localhost');
  });

  it('refuses cross-origin reads', () => {
    expect(config.server?.cors).toBe(false);
  });

  it('dedupes react to one module instance', () => {
    expect(config.resolve?.dedupe).toContain('react');
  });
});
