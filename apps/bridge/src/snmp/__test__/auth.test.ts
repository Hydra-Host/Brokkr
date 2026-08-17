import { describe, expect, it } from 'vitest';

import { buildAuthData, getAvailableAuthProtocols, getAvailablePrivProtocols, SnmpAuthError } from '../auth.js';

describe('protocol maps', () => {
  it('exposes MD5 and SHA among auth protocols', () => {
    const protos = getAvailableAuthProtocols();
    expect(protos).toContain('MD5');
    expect(protos).toContain('SHA');
  });

  it('exposes DES among priv protocols', () => {
    const protos = getAvailablePrivProtocols();
    expect(protos).toContain('DES');
  });
});

describe('buildAuthData (v1/v2c)', () => {
  it('builds a community session descriptor for v1', () => {
    const auth = buildAuthData({ version: '1', community: 'public' });
    expect(auth.kind).toBe('community');
    if (auth.kind === 'community') {
      expect(auth.community).toBe('public');
    }
  });

  it('builds a community session descriptor for v2c', () => {
    const auth = buildAuthData({ version: '2c', community: 'private' });
    expect(auth.kind).toBe('community');
    if (auth.kind === 'community') {
      expect(auth.community).toBe('private');
    }
  });
});

describe('buildAuthData (v3)', () => {
  it('builds a noAuthNoPriv USM descriptor', () => {
    const auth = buildAuthData({
      version: '3',
      username: 'testuser',
      security_level: 'noAuthNoPriv',
    });
    expect(auth.kind).toBe('usm');
    if (auth.kind === 'usm') {
      expect(auth.user.name).toBe('testuser');
    }
  });

  it('builds an authNoPriv USM descriptor', () => {
    const auth = buildAuthData({
      version: '3',
      username: 'testuser',
      security_level: 'authNoPriv',
      auth_protocol: 'SHA',
      auth_passphrase: 'authpass123',
    });
    expect(auth.kind).toBe('usm');
    if (auth.kind === 'usm') {
      expect(auth.user.authKey).toBe('authpass123');
    }
  });

  it('builds an authPriv USM descriptor', () => {
    const auth = buildAuthData({
      version: '3',
      username: 'testuser',
      security_level: 'authPriv',
      auth_protocol: 'SHA',
      auth_passphrase: 'authpass123',
      priv_protocol: 'DES',
      priv_passphrase: 'privpass123',
    });
    expect(auth.kind).toBe('usm');
    if (auth.kind === 'usm') {
      expect(auth.user.privKey).toBe('privpass123');
    }
  });

  it('raises SnmpAuthError on unknown auth protocol', () => {
    expect(() =>
      buildAuthData({
        version: '3',
        username: 'testuser',
        security_level: 'authPriv',
        auth_protocol: 'NONEXISTENT',
        auth_passphrase: 'x',
        priv_protocol: 'DES',
        priv_passphrase: 'x',
      }),
    ).toThrow(SnmpAuthError);
    expect(() =>
      buildAuthData({
        version: '3',
        username: 'testuser',
        security_level: 'authPriv',
        auth_protocol: 'NONEXISTENT',
        auth_passphrase: 'x',
        priv_protocol: 'DES',
        priv_passphrase: 'x',
      }),
    ).toThrow(/Auth protocol/);
  });

  it('raises SnmpAuthError on unknown priv protocol', () => {
    expect(() =>
      buildAuthData({
        version: '3',
        username: 'testuser',
        security_level: 'authPriv',
        auth_protocol: 'SHA',
        auth_passphrase: 'x',
        priv_protocol: 'NONEXISTENT',
        priv_passphrase: 'x',
      }),
    ).toThrow(/Priv protocol/);
  });
});
