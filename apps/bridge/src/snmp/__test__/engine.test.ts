import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const createSession = vi.fn();
  const createV3Session = vi.fn();
  return { createSession, createV3Session };
});

vi.mock('net-snmp', () => ({
  Version1: 0,
  Version2c: 1,
  Version3: 3,
  ObjectType: {},
  SecurityLevel: { noAuthNoPriv: 1, authNoPriv: 2, authPriv: 3 },
  AuthProtocols: { none: 1, md5: 2, sha: 3, sha224: 4, sha256: 5, sha384: 6, sha512: 7 },
  PrivProtocols: { none: 1, des: 2, aes: 4, aes256b: 6, aes256r: 8 },
  createSession: mocks.createSession,
  createV3Session: mocks.createV3Session,
  isVarbindError: () => false,
  varbindError: () => '',
}));

import { AuthData, buildAuthData } from '../auth.js';
import { getSnmpEngine, SnmpEngine } from '../engine.js';

function fakeSession() {
  return { on: vi.fn(), close: vi.fn() };
}

const COMMUNITY: AuthData = { kind: 'community', community: 'public', version: 1 };
const OPTIONS = { timeoutMs: 10_000, retries: 1 };

beforeEach(() => {
  mocks.createSession.mockReset();
  mocks.createV3Session.mockReset();
  mocks.createSession.mockImplementation(() => fakeSession());
  mocks.createV3Session.mockImplementation(() => fakeSession());
});

describe('SnmpEngine.createSession', () => {
  it('builds a fresh community session on every call (no caching)', () => {
    const engine = new SnmpEngine();

    engine.createSession('10.0.0.9', 161, COMMUNITY, OPTIONS);
    engine.createSession('10.0.0.9', 161, COMMUNITY, OPTIONS);

    expect(mocks.createSession).toHaveBeenCalledTimes(2);
    expect(mocks.createSession).toHaveBeenCalledWith('10.0.0.9', 'public', {
      port: 161,
      timeout: 10_000,
      retries: 1,
      version: 1,
    });
  });

  it('uses createV3Session for USM auth data', () => {
    const engine = new SnmpEngine();
    const authData = buildAuthData({
      version: '3',
      security_level: 'authPriv',
      username: 'monitor',
      auth_protocol: 'SHA256',
      auth_passphrase: 'authpass',
      priv_protocol: 'AES128',
      priv_passphrase: 'privpass',
    });

    engine.createSession('10.0.0.9', 161, authData, OPTIONS);

    expect(mocks.createV3Session).toHaveBeenCalledTimes(1);
    expect(mocks.createV3Session).toHaveBeenCalledWith(
      '10.0.0.9',
      { name: 'monitor', level: 3, authProtocol: 5, authKey: 'authpass', privProtocol: 4, privKey: 'privpass' },
      { port: 161, timeout: 10_000, retries: 1 },
    );
  });

  it('maps AES256 to the Reeder key-extension variant', () => {
    const engine = new SnmpEngine();
    const authData = buildAuthData({
      version: '3',
      security_level: 'authPriv',
      username: 'monitor',
      auth_protocol: 'SHA256',
      auth_passphrase: 'authpass',
      priv_protocol: 'AES256',
      priv_passphrase: 'privpass',
    });

    engine.createSession('10.0.0.9', 161, authData, OPTIONS);

    expect(mocks.createV3Session).toHaveBeenCalledWith(
      '10.0.0.9',
      { name: 'monitor', level: 3, authProtocol: 5, authKey: 'authpass', privProtocol: 8, privKey: 'privpass' },
      { port: 161, timeout: 10_000, retries: 1 },
    );
  });

  it('throws after close() until start() is called again', async () => {
    const engine = new SnmpEngine();
    await engine.close();

    expect(() => engine.createSession('10.0.0.9', 161, COMMUNITY, OPTIONS)).toThrow(
      'SnmpEngine is closed — call start() before using',
    );

    await engine.start();
    expect(() => engine.createSession('10.0.0.9', 161, COMMUNITY, OPTIONS)).not.toThrow();
  });
});

describe('SnmpEngine.acquire', () => {
  it('caps concurrent operations at SNMP_MAX_CONCURRENT_OPS', async () => {
    const prev = process.env.SNMP_MAX_CONCURRENT_OPS;
    process.env.SNMP_MAX_CONCURRENT_OPS = '2';
    try {
      const engine = new SnmpEngine();
      let inFlight = 0;
      let peak = 0;
      const release: Array<() => void> = [];

      const runners = Array.from({ length: 5 }, () =>
        engine.acquire(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise<void>((resolve) => release.push(resolve));
          inFlight -= 1;
        }),
      );

      await new Promise((resolve) => setImmediate(resolve));
      expect(peak).toBe(2);

      while (release.length > 0) {
        const fn = release.shift();
        if (fn !== undefined) fn();
        await new Promise((resolve) => setImmediate(resolve));
      }
      await Promise.all(runners);
      expect(peak).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.SNMP_MAX_CONCURRENT_OPS;
      else process.env.SNMP_MAX_CONCURRENT_OPS = prev;
    }
  });
});

describe('SnmpEngine.close', () => {
  it('blocks createSession after close', async () => {
    const engine = new SnmpEngine();
    await engine.start();

    await engine.close();

    expect(() => engine.createSession('10.0.0.9', 161, COMMUNITY, OPTIONS)).toThrow();
  });
});

describe('getSnmpEngine', () => {
  it('returns a module-level singleton', () => {
    expect(getSnmpEngine()).toBe(getSnmpEngine());
  });
});
