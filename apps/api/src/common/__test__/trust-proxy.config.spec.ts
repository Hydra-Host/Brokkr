import { describe, expect, it } from 'vitest';

import { resolveTrustProxyConfig } from '../trust-proxy.config';

describe('resolveTrustProxyConfig', () => {
  it('does not trust proxies by default (unset)', () => {
    expect(resolveTrustProxyConfig({})).toEqual({ setting: false });
  });

  it('does not trust proxies for false/0', () => {
    expect(resolveTrustProxyConfig({ TRUST_PROXY: 'false' })).toEqual({ setting: false });
    expect(resolveTrustProxyConfig({ TRUST_PROXY: '0' })).toEqual({ setting: false });
  });

  it('trusts the first hop for true/1', () => {
    expect(resolveTrustProxyConfig({ TRUST_PROXY: 'true' })).toEqual({ setting: true });
    expect(resolveTrustProxyConfig({ TRUST_PROXY: '1' })).toEqual({ setting: true });
  });

  it('trusts a hop count', () => {
    expect(resolveTrustProxyConfig({ TRUST_PROXY: '2' })).toEqual({ setting: 2 });
  });

  it('passes through an address/preset string', () => {
    expect(resolveTrustProxyConfig({ TRUST_PROXY: 'loopback' })).toEqual({ setting: 'loopback' });
    expect(resolveTrustProxyConfig({ TRUST_PROXY: '10.0.0.0/8' })).toEqual({ setting: '10.0.0.0/8' });
    expect(resolveTrustProxyConfig({ TRUST_PROXY: 'loopback, 192.168.0.0/16' })).toEqual({
      setting: 'loopback, 192.168.0.0/16',
    });
  });

  it.each(['abc', '1.5', '-1', '10.0.0.0/33', 'loopback,bogus', '127.0.0.1,,10.0.0.0'])(
    'rejects malformed value %j with a clear error',
    (value) => {
      expect(() => resolveTrustProxyConfig({ TRUST_PROXY: value })).toThrow(/Invalid TRUST_PROXY/);
    },
  );
});
