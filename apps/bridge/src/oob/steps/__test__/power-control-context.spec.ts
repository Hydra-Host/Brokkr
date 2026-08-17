import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SagaContext } from '../../../saga-framework/saga.types.js';
import { credsFromContext, skipIfBrokkrLiveReady } from '../power-control-context.js';
import { clearZoneCrypto, installZoneCrypto, sealedBmc, sealedCredPayload } from './sealed-bmc.testutil.js';

function makeCtx(overrides: Partial<SagaContext> = {}): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'pc_power_on',
    deviceId: 'device-1',
    payload: {},
    jobId: 'job-1',
    attempt: 1,
    metadata: {},
    stepResults: {},
    ...overrides,
  };
}

function credPayload(plaintext: { user: string; pass: string } = { user: 'admin', pass: 's3cret' }) {
  return sealedCredPayload({ user: plaintext.user, pass: plaintext.pass });
}

describe('credsFromContext', () => {
  beforeEach(() => {
    installZoneCrypto();
  });
  afterEach(() => {
    clearZoneCrypto();
  });

  it('opens the inner sealed secret and returns bmc_ip + decrypted username/password', () => {
    const ctx = makeCtx({ payload: credPayload() });
    expect(credsFromContext(ctx)).toEqual({ bmcIp: '10.0.0.9', username: 'admin', password: 's3cret' });
  });

  it('reads bmc_ip from the payload root in the clear (not from the sealed blob)', () => {
    const ctx = makeCtx({ payload: { ...credPayload(), bmc_ip: '192.168.5.5' } });
    expect(credsFromContext(ctx).bmcIp).toBe('192.168.5.5');
  });

  it('rejects a payload that omits the sealed secrets envelope', () => {
    expect(() => credsFromContext(makeCtx({ payload: { bmc_ip: '10.0.0.9' } }))).toThrow(TypeError);
  });

  it('rejects a payload that still carries plaintext root creds', () => {
    const ctx = makeCtx({ payload: { bmc_ip: '10.0.0.9', username: 'admin', password: 's3cret' } });
    expect(() => credsFromContext(ctx)).toThrow(TypeError);
  });

  it.each([
    ['null', null],
    ['number', 12345],
    ['empty string', ''],
  ])('rejects a non-string bmc_ip (%s)', (_label, bmcIp) => {
    const ctx = makeCtx({ payload: { ...credPayload(), bmc_ip: bmcIp } });
    expect(() => credsFromContext(ctx)).toThrow(TypeError);
  });

  it('throws when the sealed secret cannot be opened (zone crypto not loaded)', () => {
    const ctx = makeCtx({ payload: credPayload() });
    clearZoneCrypto();
    expect(() => credsFromContext(ctx)).toThrow(/zone_crypto not loaded/);
  });

  it('throws when the inner blob fails the tag (tampered device binding)', () => {
    const sealed = sealedBmc({ user: 'admin', pass: 's3cret' });
    const ctx = makeCtx({ payload: { bmc_ip: '10.0.0.9', secrets: { bmc: { ...sealed, deviceId: 'other' } } } });
    expect(() => credsFromContext(ctx)).toThrow();
  });
});

describe('skipIfBrokkrLiveReady (gaps not covered by the brokkr-live-skip spec)', () => {
  it.each([
    ['number', 1],
    ['boolean true', true],
  ])('throws when brokkr_live_check is a primitive (%s)', (_label, value) => {
    const ctx = makeCtx({ stepResults: { brokkr_live_check: value } });
    expect(() => skipIfBrokkrLiveReady(ctx)).toThrow(TypeError);
  });

  it('does not skip when rewound is a truthy non-boolean value', () => {
    const ctx = makeCtx({ metadata: { rewound: 'yes' }, stepResults: { brokkr_live_check: { ready: true } } });
    expect(skipIfBrokkrLiveReady(ctx)).toBeNull();
  });

  it.each([
    ['false', false],
    ['0', 0],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
  ])('treats rewound=%s as not-rewound (so a ready check can still skip)', (_label, rewound) => {
    const ctx = makeCtx({ metadata: { rewound }, stepResults: { brokkr_live_check: { ready: true } } });
    expect(skipIfBrokkrLiveReady(ctx)).toEqual({ skipped: true, reason: 'Brokkr Live already running' });
  });

  it('does not skip when deploy_os ran with a truthy non-object value', () => {
    const ctx = makeCtx({ stepResults: { deploy_os: 'done', brokkr_live_check: { ready: true } } });
    expect(skipIfBrokkrLiveReady(ctx)).toBeNull();
  });

  it.each([
    ['false', false],
    ['0', 0],
    ['empty string', ''],
  ])('treats deploy_os=%s as not-run (so a ready check can still skip)', (_label, deployOs) => {
    const ctx = makeCtx({ stepResults: { deploy_os: deployOs, brokkr_live_check: { ready: true } } });
    expect(skipIfBrokkrLiveReady(ctx)).toEqual({ skipped: true, reason: 'Brokkr Live already running' });
  });

  it.each([
    ['number 1', 1],
    ['non-empty string', 'yes'],
  ])('skips when brokkr_live_check.ready is a truthy non-boolean (%s)', (_label, ready) => {
    const ctx = makeCtx({ stepResults: { brokkr_live_check: { ready } } });
    expect(skipIfBrokkrLiveReady(ctx)).toEqual({ skipped: true, reason: 'Brokkr Live already running' });
  });
});
