import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildRedfishConfig,
  isRedfishTlsVerificationEnabled,
  isTlsCertVerificationError,
  redfishRejectUnauthorized,
  redfishTlsVerificationDisabledMessage,
  redfishTlsVerificationDisabledReason,
  redfishTlsVerificationFailureHint,
  resetRedfishTlsVerificationDisabledWarningForTest,
  warnRedfishTlsVerificationDisabledOnce,
} from '../redfish.config.js';

describe('redfishRejectUnauthorized / isRedfishTlsVerificationEnabled', () => {
  it('does NOT verify by default (empty env)', () => {
    expect(isRedfishTlsVerificationEnabled({})).toBe(false);
    expect(redfishRejectUnauthorized({})).toBe(false);
  });

  it('does NOT verify by default regardless of environment', () => {
    for (const environment of ['prod', 'stg', 'local', 'dev']) {
      expect(redfishRejectUnauthorized({ BROKKR_ENV: environment })).toBe(false);
    }
  });

  it('verifies when REDFISH_TLS_VERIFY=true regardless of env', () => {
    expect(isRedfishTlsVerificationEnabled({ BROKKR_ENV: 'prod', REDFISH_TLS_VERIFY: 'true' })).toBe(true);
    expect(redfishRejectUnauthorized({ BROKKR_ENV: 'prod', REDFISH_TLS_VERIFY: 'true' })).toBe(true);
    expect(redfishRejectUnauthorized({ BROKKR_ENV: 'local', REDFISH_TLS_VERIFY: 'true' })).toBe(true);
  });

  it('matches REDFISH_TLS_VERIFY case-insensitively', () => {
    expect(redfishRejectUnauthorized({ REDFISH_TLS_VERIFY: 'TRUE' })).toBe(true);
  });

  it('treats any non-true value as opt-out (off)', () => {
    expect(redfishRejectUnauthorized({ REDFISH_TLS_VERIFY: 'false' })).toBe(false);
    expect(redfishRejectUnauthorized({ REDFISH_TLS_VERIFY: '1' })).toBe(false);
    expect(redfishRejectUnauthorized({ REDFISH_TLS_VERIFY: '' })).toBe(false);
  });
});

describe('isTlsCertVerificationError', () => {
  it('recognizes certificate-verification error codes', () => {
    for (const code of [
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'CERT_HAS_EXPIRED',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ]) {
      expect(isTlsCertVerificationError(Object.assign(new Error('tls'), { code }))).toBe(true);
    }
  });

  it('does not flag connect/timeout errors or non-errors', () => {
    expect(isTlsCertVerificationError(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(false);
    expect(isTlsCertVerificationError(new Error('no code'))).toBe(false);
    expect(isTlsCertVerificationError('SELF_SIGNED_CERT_IN_CHAIN')).toBe(false);
    expect(isTlsCertVerificationError(null)).toBe(false);
  });
});

describe('redfishTlsVerificationFailureHint', () => {
  it('advises installing a trusted CA or unsetting the opt-in flag', () => {
    const hint = redfishTlsVerificationFailureHint('10.0.0.5:443');
    expect(hint).toContain('REDFISH_TLS_VERIFY');
    expect(hint).toContain('trusted CA');
    expect(hint).toContain('10.0.0.5:443');
  });

  it('omits the host fragment when none is provided', () => {
    const hint = redfishTlsVerificationFailureHint();
    expect(hint).toContain('REDFISH_TLS_VERIFY');
    expect(hint).not.toContain('to BMC');
  });
});

describe('redfishTlsVerificationDisabledReason / Message', () => {
  it('attributes the disabled state to the unset opt-in flag', () => {
    const reason = redfishTlsVerificationDisabledReason({ BROKKR_ENV: 'prod' });
    expect(reason).toContain('REDFISH_TLS_VERIFY is not set');
  });

  it('builds an actionable MITM warning that points at the opt-in flag', () => {
    const message = redfishTlsVerificationDisabledMessage('10.0.0.5:443', { BROKKR_ENV: 'prod' });
    expect(message).toContain('DISABLED');
    expect(message).toContain('MITM');
    expect(message).toContain('10.0.0.5:443');
    expect(message).toContain('REDFISH_TLS_VERIFY=true');
  });
});

describe('warnRedfishTlsVerificationDisabledOnce', () => {
  beforeEach(() => resetRedfishTlsVerificationDisabledWarningForTest());
  afterEach(() => resetRedfishTlsVerificationDisabledWarningForTest());

  it('logs once via the supplied logger with the opt-in message', () => {
    const log = vi.fn();
    warnRedfishTlsVerificationDisabledOnce(log, '10.0.0.5:443', {});
    warnRedfishTlsVerificationDisabledOnce(log, '10.0.0.5:443', {});
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('REDFISH_TLS_VERIFY=true');
    expect(log.mock.calls[0][0]).toContain('10.0.0.5:443');
  });
});

describe('buildRedfishConfig NETWORK_REDFISH_PORT', () => {
  it('defaults to 443 and reads a strict integer', () => {
    expect(buildRedfishConfig({}).realRedfishPort).toBe(443);
    expect(buildRedfishConfig({ NETWORK_REDFISH_PORT: '8443' }).realRedfishPort).toBe(8443);
    expect(buildRedfishConfig({ NETWORK_REDFISH_PORT: '8_443' }).realRedfishPort).toBe(8443);
  });

  it('rejects a value that is not an integer instead of yielding NaN or a truncation', () => {
    expect(() => buildRedfishConfig({ NETWORK_REDFISH_PORT: 'https' })).toThrow();
    expect(() => buildRedfishConfig({ NETWORK_REDFISH_PORT: '443x' })).toThrow();
    expect(() => buildRedfishConfig({ NETWORK_REDFISH_PORT: '' })).toThrow();
  });
});

describe('buildRedfishConfig SIM_REDFISH_PORT', () => {
  it('defaults to 8443 and reads a strict integer', () => {
    expect(buildRedfishConfig({}).simRedfishPort).toBe(8443);
    expect(buildRedfishConfig({ SIM_REDFISH_PORT: '9001' }).simRedfishPort).toBe(9001);
    expect(buildRedfishConfig({ SIM_REDFISH_PORT: '9_001' }).simRedfishPort).toBe(9001);
  });

  it('rejects a value that is not an integer instead of yielding NaN or a truncation', () => {
    expect(() => buildRedfishConfig({ SIM_REDFISH_PORT: 'sushy' })).toThrow();
    expect(() => buildRedfishConfig({ SIM_REDFISH_PORT: '8443x' })).toThrow();
    expect(() => buildRedfishConfig({ SIM_REDFISH_PORT: '' })).toThrow();
  });
});
