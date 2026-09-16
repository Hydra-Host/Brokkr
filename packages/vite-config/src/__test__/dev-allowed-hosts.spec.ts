import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { devAllowedHosts } from '../dev-server.js';

const DEFAULTS = ['localhost', '.localhost', '127.0.0.1', '::1'];

describe('devAllowedHosts', () => {
  beforeEach(() => {
    vi.stubEnv('HOST', '');
    vi.stubEnv('ALLOWED_HOSTS', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps vite 7 wildcard-localhost default', () => {
    expect(devAllowedHosts()).toEqual(DEFAULTS);
  });

  it('adds a named HOST bind', () => {
    vi.stubEnv('HOST', 'mymachine.local');
    expect(devAllowedHosts()).toEqual([...DEFAULTS, 'mymachine.local']);
  });

  it('adds nothing for an all-interfaces HOST bind', () => {
    vi.stubEnv('HOST', '0.0.0.0');
    expect(devAllowedHosts()).toEqual(DEFAULTS);
  });

  it('adds nothing for an all-interfaces ipv6 HOST bind', () => {
    vi.stubEnv('HOST', '::');
    expect(devAllowedHosts()).toEqual(DEFAULTS);
  });

  it('adds nothing for a whitespace-only HOST', () => {
    vi.stubEnv('HOST', '   ');
    expect(devAllowedHosts()).toEqual(DEFAULTS);
  });

  it('splits and trims ALLOWED_HOSTS', () => {
    vi.stubEnv('ALLOWED_HOSTS', ' a.example.com , b.example.com ,, ');
    expect(devAllowedHosts()).toEqual([...DEFAULTS, 'a.example.com', 'b.example.com']);
  });

  it('collapses a host already in the defaults', () => {
    vi.stubEnv('ALLOWED_HOSTS', '192.168.1.20,localhost,127.0.0.1');
    expect(devAllowedHosts()).toEqual([...DEFAULTS, '192.168.1.20']);
  });
});
