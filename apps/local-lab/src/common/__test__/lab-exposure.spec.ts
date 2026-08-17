import { ForbiddenException } from '@nestjs/common';
import { afterEach } from 'vitest';

import { assertExposure, exposureAllowed } from '../lab-exposure';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('exposureAllowed / token-ok', () => {
  it('always allows, whatever the peer and the forwarded chain', () => {
    expect(exposureAllowed('token-ok', '10.0.0.5', undefined)).toBe(true);
    expect(exposureAllowed('token-ok', '10.0.0.5', '10.0.0.5, 192.168.1.7')).toBe(true);
    expect(exposureAllowed('token-ok', undefined, undefined)).toBe(true);
  });
});

describe('exposureAllowed / loopback-only', () => {
  it('allows a loopback peer with no forwarded header', () => {
    for (const peer of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', 'localhost']) {
      expect(exposureAllowed('loopback-only', peer, undefined)).toBe(true);
    }
  });

  it('denies a non-loopback peer', () => {
    for (const peer of ['10.0.0.5', '192.168.1.20', '0.0.0.0', '::ffff:10.0.0.5', undefined, '']) {
      expect(exposureAllowed('loopback-only', peer, undefined)).toBe(false);
    }
  });

  it('denies a loopback peer whose forwarded chain carries a non-loopback hop', () => {
    expect(exposureAllowed('loopback-only', '127.0.0.1', '10.0.0.5')).toBe(false);
    expect(exposureAllowed('loopback-only', '127.0.0.1', '10.0.0.5, 127.0.0.1')).toBe(false);
    expect(exposureAllowed('loopback-only', '127.0.0.1', '127.0.0.1, 10.0.0.5')).toBe(false);
    expect(exposureAllowed('loopback-only', '127.0.0.1', ['127.0.0.1', '10.0.0.5'])).toBe(false);
  });

  it('allows a loopback peer whose forwarded chain is all loopback', () => {
    expect(exposureAllowed('loopback-only', '127.0.0.1', '127.0.0.1')).toBe(true);
    expect(exposureAllowed('loopback-only', '127.0.0.1', '127.0.0.1, ::1, ::ffff:127.0.0.1')).toBe(true);
    expect(exposureAllowed('loopback-only', '::1', ['127.0.0.1', '::1'])).toBe(true);
  });

  it('denies a forwarded header that is present but carries no hop (fail-closed)', () => {
    expect(exposureAllowed('loopback-only', '127.0.0.1', '')).toBe(false);
    expect(exposureAllowed('loopback-only', '127.0.0.1', ' , ')).toBe(false);
  });

  it('ignores LAB_TRUST_PROXY — the hop check does not depend on it', () => {
    vi.stubEnv('LAB_TRUST_PROXY', '1');
    expect(exposureAllowed('loopback-only', '127.0.0.1', '10.0.0.5')).toBe(false);
    vi.stubEnv('LAB_TRUST_PROXY', '');
    expect(exposureAllowed('loopback-only', '127.0.0.1', '10.0.0.5')).toBe(false);
  });
});

describe('exposureAllowed / LAB_ALLOW_REMOTE_SHARP', () => {
  it('allows a remote peer on the exact opt-in value', () => {
    vi.stubEnv('LAB_ALLOW_REMOTE_SHARP', '1');
    expect(exposureAllowed('loopback-only', '10.0.0.5', undefined)).toBe(true);
    expect(exposureAllowed('loopback-only', '10.0.0.5', '10.0.0.5, 192.168.1.7')).toBe(true);
  });

  it('denies on any other value and when unset', () => {
    for (const value of ['0', 'true', 'yes', 'on', '', ' 1']) {
      vi.stubEnv('LAB_ALLOW_REMOTE_SHARP', value);
      expect(exposureAllowed('loopback-only', '10.0.0.5', undefined)).toBe(false);
    }
    vi.unstubAllEnvs();
    expect(process.env.LAB_ALLOW_REMOTE_SHARP).toBeUndefined();
    expect(exposureAllowed('loopback-only', '10.0.0.5', undefined)).toBe(false);
  });
});

describe('assertExposure', () => {
  it('returns silently when allowed', () => {
    expect(() => assertExposure('loopback-only', '127.0.0.1', undefined)).not.toThrow();
    expect(() => assertExposure('token-ok', '10.0.0.5', undefined)).not.toThrow();
  });

  it('throws ForbiddenException naming the opt-in env var when denied', () => {
    expect(() => assertExposure('loopback-only', '10.0.0.5', undefined)).toThrow(ForbiddenException);
    expect(() => assertExposure('loopback-only', '10.0.0.5', undefined)).toThrow(/LAB_ALLOW_REMOTE_SHARP/);
  });
});
