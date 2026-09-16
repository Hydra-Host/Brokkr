import { describe, expect, it } from 'vitest';

import {
  assertChainReachability,
  evaluateChainReachability,
  type ChainReachabilityInput,
} from '../chain-reachability-assert.js';
import type { StartupLogger } from '../startup-deps.types.js';

function recordingLogger(): { logger: StartupLogger; errors: string[]; warns: string[] } {
  const errors: string[] = [];
  const warns: string[] = [];
  const logger: StartupLogger = {
    info: () => undefined,
    warn: (message) => {
      warns.push(message);
    },
    error: (message) => {
      errors.push(message);
    },
    debug: () => undefined,
  };
  return { logger, errors, warns };
}

function healthyInput(overrides: Partial<ChainReachabilityInput> = {}): ChainReachabilityInput {
  return {
    bridgeUrl: 'https://brokkr.lan',
    listenHost: '0.0.0.0',
    dnsEnabled: true,
    dnsAdvertised: true,
    tlsTerminated: true,
    dhcpMode: 'AUTHORITATIVE',
    ...overrides,
  };
}

describe('evaluateChainReachability', () => {
  it('healthy authoritative-proxy deploy has no findings', () => {
    expect(evaluateChainReachability(healthyInput())).toEqual([]);
  });

  it('PXE-07: advertising brokkr.lan with DNS disabled is flagged', () => {
    const findings = evaluateChainReachability(healthyInput({ dnsEnabled: false }));
    expect(findings.map((f) => f.code)).toContain('PXE-07');
  });

  it('PXE-07: advertising brokkr.lan with DNS enabled but not advertised is flagged', () => {
    const findings = evaluateChainReachability(healthyInput({ dnsAdvertised: false }));
    expect(findings.map((f) => f.code)).toContain('PXE-07');
  });

  it('PXE-07: external DNS advertised with bridge DNS off is a warn', () => {
    const f = evaluateChainReachability(healthyInput({ dnsEnabled: false, dnsAdvertised: true })).find(
      (x) => x.code === 'PXE-07',
    );
    expect(f?.severity).toBe('warn');
  });

  it('PXE-07: neither DNS enabled nor advertised is a warn (atoms may enable at runtime)', () => {
    const f = evaluateChainReachability(
      healthyInput({ dnsEnabled: false, dnsAdvertised: false }),
    ).find((x) => x.code === 'PXE-07');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('warn');
  });

  it('PXE-07: DNS enabled but not advertised is an error', () => {
    const f = evaluateChainReachability(
      healthyInput({ dnsEnabled: true, dnsAdvertised: false }),
    ).find((x) => x.code === 'PXE-07');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('error');
  });

  it('PXE-07: PROXY mode does not flag brokkr.lan (external authoritative DHCP owns option 6)', () => {
    const findings = evaluateChainReachability(
      healthyInput({ dhcpMode: 'PROXY', dnsAdvertised: false, dnsEnabled: false }),
    );
    expect(findings.map((f) => f.code)).not.toContain('PXE-07');
  });

  it('PXE-07: AUTHORITATIVE mode still flags brokkr.lan when no resolver is advertised', () => {
    const findings = evaluateChainReachability(healthyInput({ dhcpMode: 'AUTHORITATIVE', dnsAdvertised: false }));
    expect(findings.map((f) => f.code)).toContain('PXE-07');
  });

  it('PXE-07: a non-brokkr.lan BRIDGE_URL is not flagged for DNS', () => {
    const findings = evaluateChainReachability(
      healthyInput({
        bridgeUrl: 'http://10.0.0.5:8080',
        dnsEnabled: false,
        dnsAdvertised: false,
        tlsTerminated: false,
      }),
    );
    expect(findings.map((f) => f.code)).not.toContain('PXE-07');
  });

  it('PXE-02: https chain + loopback bind + no TLS terminator is flagged', () => {
    const findings = evaluateChainReachability(healthyInput({ listenHost: '127.0.0.1', tlsTerminated: false }));
    expect(findings.map((f) => f.code)).toContain('PXE-02');
  });

  it('PXE-02: a declared TLS terminator clears the https-vs-loopback mismatch', () => {
    const findings = evaluateChainReachability(healthyInput({ listenHost: '127.0.0.1', tlsTerminated: true }));
    expect(findings.map((f) => f.code)).not.toContain('PXE-02');
  });

  it('PXE-02: http BRIDGE_URL pointing at the real port is not flagged', () => {
    const findings = evaluateChainReachability(
      healthyInput({ bridgeUrl: 'http://brokkr.lan:8080', listenHost: '127.0.0.1', tlsTerminated: false }),
    );
    expect(findings.map((f) => f.code)).not.toContain('PXE-02');
  });

  it('malformed BRIDGE_URL surfaces a single PXE-02 finding', () => {
    const findings = evaluateChainReachability(healthyInput({ bridgeUrl: 'not a url' }));
    expect(findings.map((f) => f.code)).toEqual(['PXE-02']);
  });




});

describe('assertChainReachability', () => {
  it('logs findings at their severity level (loud, not silent)', () => {
    const { logger, errors, warns } = recordingLogger();
    assertChainReachability(healthyInput({ dnsEnabled: false, listenHost: '127.0.0.1', tlsTerminated: false }), logger);
    expect(errors.some((e) => e.includes('PXE-02'))).toBe(true);
    expect(warns.some((w) => w.includes('PXE-07'))).toBe(true);
  });

  it('returns the findings without throwing by default', () => {
    const { logger } = recordingLogger();
    const findings = assertChainReachability(healthyInput({ dnsEnabled: false }), logger);
    expect(findings.map((f) => f.code)).toEqual(['PXE-07']);
  });

  it('throws under strict mode when there is an error-level finding', () => {
    const { logger } = recordingLogger();
    expect(() => assertChainReachability(healthyInput({ dnsAdvertised: false }), logger, { strict: true })).toThrow(
      /Chain reachability assertion failed/,
    );
  });

  it('strict mode does not throw when the only finding is a warn-level PXE-07', () => {
    const { logger } = recordingLogger();
    expect(() =>
      assertChainReachability(healthyInput({ dnsEnabled: false, dnsAdvertised: true }), logger, { strict: true }),
    ).not.toThrow();
  });

  it('returns no findings under strict mode when healthy', () => {
    const { logger } = recordingLogger();
    expect(assertChainReachability(healthyInput(), logger, { strict: true })).toEqual([]);
  });
});
