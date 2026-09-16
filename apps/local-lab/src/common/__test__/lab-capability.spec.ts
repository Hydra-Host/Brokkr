import { ForbiddenException, Logger, UnauthorizedException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type Capability,
  capabilityAllowed,
  capabilityRank,
  capabilityRefusal,
  labMode,
  requestAllows,
  requestPrincipal,
  unauthenticatedRefusal,
} from '../lab-capability';
import { resolvePrincipal } from '../lab-net';

const API: Capability[] = ['read', 'operate', 'admin'];
const REMOTE = '10.0.0.5';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function apiPrincipal() {
  vi.stubEnv('LAB_API_TOKEN', 'api-token');
  return resolvePrincipal('api-token');
}

function hostPrincipal() {
  vi.stubEnv('LAB_HOST_TOKEN', 'host-token');
  return resolvePrincipal('host-token');
}

describe('capabilityRank', () => {
  it('orders read below operate below admin below host-exec', () => {
    const ranks = (['read', 'operate', 'admin', 'host-exec'] as const).map(capabilityRank);
    expect(ranks).toEqual([0, 1, 2, 3]);
  });
});

describe('resolvePrincipal', () => {
  it('resolves the api token to an admin ceiling', () => {
    vi.stubEnv('LAB_API_TOKEN', 'api-token');
    expect(resolvePrincipal('api-token')).toEqual({ id: 'api', ceiling: 'admin' });
  });

  it('resolves the host token to a host-exec ceiling', () => {
    vi.stubEnv('LAB_HOST_TOKEN', 'host-token');
    expect(resolvePrincipal('host-token')).toEqual({ id: 'host', ceiling: 'host-exec' });
  });

  it('returns null for a wrong, empty or absent token', () => {
    vi.stubEnv('LAB_API_TOKEN', 'api-token');
    expect(resolvePrincipal('api-toke')).toBeNull();
    expect(resolvePrincipal('')).toBeNull();
    expect(resolvePrincipal(undefined)).toBeNull();
    expect(resolvePrincipal(null)).toBeNull();
  });

  it('returns null for every candidate when no token is configured', () => {
    vi.stubEnv('LAB_API_TOKEN', undefined);
    vi.stubEnv('LAB_HOST_TOKEN', undefined);
    expect(resolvePrincipal('anything')).toBeNull();
    expect(resolvePrincipal('')).toBeNull();
  });

  it('refuses every principal while the two tokens hold the same value', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.stubEnv('LAB_API_TOKEN', 'same-token');
    vi.stubEnv('LAB_HOST_TOKEN', 'same-token');
    expect(resolvePrincipal('same-token')).toBeNull();
  });

  it('resolves again once the collision is repaired', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.stubEnv('LAB_API_TOKEN', 'api-token');
    vi.stubEnv('LAB_HOST_TOKEN', 'api-token');
    expect(resolvePrincipal('api-token')).toBeNull();
    vi.stubEnv('LAB_HOST_TOKEN', 'host-token');
    expect(resolvePrincipal('api-token')).toEqual({ id: 'api', ceiling: 'admin' });
    expect(resolvePrincipal('host-token')).toEqual({ id: 'host', ceiling: 'host-exec' });
  });

  it('reports the collision once, naming both variables and neither value', () => {
    vi.stubEnv('LAB_API_TOKEN', 'api-token');
    vi.stubEnv('LAB_HOST_TOKEN', 'host-token');
    resolvePrincipal('api-token');
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.stubEnv('LAB_HOST_TOKEN', 'api-token');
    resolvePrincipal('api-token');
    resolvePrincipal('api-token');
    expect(error).toHaveBeenCalledTimes(1);
    const message = String(error.mock.calls[0][0]);
    expect(message).toContain('LAB_HOST_TOKEN');
    expect(message).toContain('LAB_API_TOKEN');
    expect(message).not.toContain('api-token');
  });

  it('does not read two unset variables as a collision', () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.stubEnv('LAB_API_TOKEN', undefined);
    vi.stubEnv('LAB_HOST_TOKEN', undefined);
    expect(resolvePrincipal('anything')).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it('does not read one unset variable as a collision', () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.stubEnv('LAB_API_TOKEN', 'api-token');
    vi.stubEnv('LAB_HOST_TOKEN', undefined);
    expect(resolvePrincipal('api-token')).toEqual({ id: 'api', ceiling: 'admin' });
    expect(error).not.toHaveBeenCalled();
  });
});

describe('capabilityAllowed / token authority', () => {
  it('grants the api principal everything up to admin from a remote address', () => {
    const principal = apiPrincipal();
    for (const capability of API) expect(capabilityAllowed(capability, principal, REMOTE, undefined)).toBe(true);
  });

  it('refuses host-exec to the api principal', () => {
    expect(capabilityAllowed('host-exec', apiPrincipal(), REMOTE, undefined)).toBe(false);
  });

  it('grants the host principal every capability', () => {
    const principal = hostPrincipal();
    for (const capability of [...API, 'host-exec' as const]) {
      expect(capabilityAllowed(capability, principal, REMOTE, undefined)).toBe(true);
    }
  });

  it('refuses read to a remote caller holding no principal', () => {
    expect(capabilityAllowed('read', null, REMOTE, undefined)).toBe(false);
  });
});

describe('capabilityAllowed / the loopback grant', () => {
  it('grants every capability to a loopback caller in loopback mode', () => {
    vi.stubEnv('LAB_MODE', undefined);
    for (const capability of [...API, 'host-exec' as const]) {
      expect(capabilityAllowed(capability, null, '127.0.0.1', undefined)).toBe(true);
    }
  });

  it('grants every capability to a loopback caller in direct mode', () => {
    vi.stubEnv('LAB_MODE', 'direct');
    for (const capability of [...API, 'host-exec' as const]) {
      expect(capabilityAllowed(capability, null, '::1', undefined)).toBe(true);
    }
  });

  it('refuses a loopback caller with no forwarded header in fronted mode', () => {
    vi.stubEnv('LAB_MODE', 'fronted');
    expect(capabilityAllowed('read', null, '127.0.0.1', undefined)).toBe(false);
  });

  it('still admits a token holder in fronted mode', () => {
    vi.stubEnv('LAB_MODE', 'fronted');
    expect(capabilityAllowed('admin', apiPrincipal(), '127.0.0.1', undefined)).toBe(true);
  });

  it('refuses an unrecognised mode the address grant', () => {
    vi.stubEnv('LAB_MODE', 'lookback');
    expect(capabilityAllowed('read', null, '127.0.0.1', undefined)).toBe(false);
  });

  it('refuses a loopback peer whose forwarded chain carries a remote hop', () => {
    for (const chain of ['10.0.0.5', '10.0.0.5, 127.0.0.1', '127.0.0.1, 10.0.0.5', ['127.0.0.1', '10.0.0.5']]) {
      expect(capabilityAllowed('read', null, '127.0.0.1', chain)).toBe(false);
    }
  });

  it('accepts a forwarded chain whose every hop is loopback', () => {
    expect(capabilityAllowed('read', null, '127.0.0.1', '127.0.0.1, ::1, ::ffff:127.0.0.1')).toBe(true);
    expect(capabilityAllowed('read', null, '::1', ['127.0.0.1', '::1'])).toBe(true);
  });

  it('refuses an empty forwarded header, which claims a hop it does not name', () => {
    expect(capabilityAllowed('read', null, '127.0.0.1', '')).toBe(false);
    expect(capabilityAllowed('read', null, '127.0.0.1', ' , ')).toBe(false);
  });

  it('refuses a remote peer whatever the forwarded chain claims', () => {
    expect(capabilityAllowed('read', null, REMOTE, '127.0.0.1')).toBe(false);
  });
});

describe('labMode', () => {
  it('defaults to loopback when unset or empty', () => {
    vi.stubEnv('LAB_MODE', undefined);
    expect(labMode()).toBe('loopback');
    vi.stubEnv('LAB_MODE', '');
    expect(labMode()).toBe('loopback');
  });

  it('reads the two other supported modes verbatim', () => {
    vi.stubEnv('LAB_MODE', 'direct');
    expect(labMode()).toBe('direct');
    vi.stubEnv('LAB_MODE', 'fronted');
    expect(labMode()).toBe('fronted');
  });

  it('reports an unrecognised value as fronted', () => {
    vi.stubEnv('LAB_MODE', 'off');
    expect(labMode()).toBe('fronted');
  });
});

describe('requestPrincipal / requestAllows', () => {
  it('reads the token from the authorization header, the lab header and the query', () => {
    vi.stubEnv('LAB_API_TOKEN', 'api-token');
    const expected = { id: 'api', ceiling: 'admin' };
    expect(requestPrincipal({ headers: { authorization: 'Bearer api-token' } })).toEqual(expected);
    expect(requestPrincipal({ headers: { 'x-lab-token': 'api-token' } })).toEqual(expected);
    expect(requestPrincipal({ headers: {}, query: { token: 'api-token' } })).toEqual(expected);
  });

  it('decides off the socket peer when express has resolved no ip', () => {
    vi.stubEnv('LAB_API_TOKEN', 'api-token');
    expect(requestAllows('read', { socket: { remoteAddress: '127.0.0.1' }, headers: {} })).toBe(true);
    expect(requestAllows('read', { socket: { remoteAddress: REMOTE }, headers: {} })).toBe(false);
    expect(
      requestAllows('host-exec', { socket: { remoteAddress: REMOTE }, headers: { authorization: 'Bearer api-token' } }),
    ).toBe(false);
  });
});

describe('capabilityRefusal', () => {
  it('names the missing capability in a 403', () => {
    const refusal = capabilityRefusal('host-exec');
    expect(refusal).toBeInstanceOf(ForbiddenException);
    expect(refusal.getStatus()).toBe(403);
    expect(refusal.message).toMatch(/host-exec/);
  });
});

describe('unauthenticatedRefusal', () => {
  it('names non-loopback callers under loopback and direct', () => {
    for (const mode of ['loopback', 'direct']) {
      vi.stubEnv('LAB_MODE', mode);
      const refusal = unauthenticatedRefusal();
      expect(refusal).toBeInstanceOf(UnauthorizedException);
      expect(refusal.getStatus()).toBe(401);
      expect(refusal.message).toBe('lab control API requires a valid lab token for non-loopback requests');
    }
  });

  it('names every caller under fronted, and says why loopback is included', () => {
    vi.stubEnv('LAB_MODE', 'fronted');
    const refusal = unauthenticatedRefusal();
    expect(refusal.getStatus()).toBe(401);
    expect(refusal.message).toBe(
      'lab control API requires a valid lab token from every caller, loopback included: a terminator dials 127.0.0.1, so a loopback peer is whoever the front door serves',
    );
    expect(refusal.message).not.toMatch(/non-loopback/);
  });

  it('reads an unrecognised mode as fronted, like labMode', () => {
    vi.stubEnv('LAB_MODE', 'typo');
    expect(unauthenticatedRefusal().message).toMatch(/loopback included/);
  });
});
