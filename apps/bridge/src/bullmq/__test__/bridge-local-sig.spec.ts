import { createCipheriv, hkdfSync } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  openBridgeLocalJob,
  sealBridgeLocalJob,
  signBridgeLocalJob,
  verifyBridgeLocalSig,
  type BridgeLocalRouting,
} from '../bridge-local-sig.js';

const KEY = Buffer.alloc(32, 1);
const DATA = {
  plan_id: 'plan-1',
  saga_name: 'provision',
  device_id: 'device-1',
  payload: {
    device_id: 'device-1',
    bmc_ip: '192.0.2.10',
    deployment_os_token: 'secret-token',
  },
};
const ROUTING: BridgeLocalRouting = {
  job_id: 'device-1-provision-plan-1',
  job_name: 'saga.run',
  queue_name: 'lifecycle',
};

function malformedJsonEnvelope(): Record<string, unknown> {
  const envelope = sealBridgeLocalJob(KEY, DATA, ROUTING);
  const ts = envelope.__bridge_local_ts;
  if (typeof ts !== 'string') throw new Error('Missing test timestamp');
  const nonce = Buffer.alloc(12, 9);
  const key = Buffer.from(
    hkdfSync('sha256', KEY, Buffer.alloc(0), Buffer.from('brokkr-bridge-local-aead-v1', 'utf8'), 32),
  );
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(
    Buffer.from(
      JSON.stringify({
        job_id: ROUTING.job_id,
        job_name: ROUTING.job_name,
        queue_name: ROUTING.queue_name,
        ts,
        v: 1,
      }),
      'utf8',
    ),
  );
  const ciphertext = Buffer.concat([cipher.update('{', 'utf8'), cipher.final()]);
  return {
    ...envelope,
    __bridge_local_nonce: nonce.toString('base64'),
    __bridge_local_ciphertext: ciphertext.toString('base64'),
    __bridge_local_tag: cipher.getAuthTag().toString('base64'),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-29T02:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('bridge-local signatures', () => {
  it('seals and opens the complete payload', () => {
    const envelope = sealBridgeLocalJob(KEY, DATA, ROUTING);
    expect(JSON.stringify(envelope)).not.toContain('secret-token');
    expect(openBridgeLocalJob(KEY, envelope, ROUTING)).toEqual(DATA);
  });

  it('rejects a changed signature', () => {
    const signed = signBridgeLocalJob(KEY, DATA, ROUTING);
    const last = signed.sig.endsWith('0') ? '1' : '0';
    expect(() => verifyBridgeLocalSig(KEY, signed.ts, `${signed.sig.slice(0, -1)}${last}`, DATA, ROUTING)).toThrow();
  });

  it('rejects a changed payload device identifier', () => {
    const signed = signBridgeLocalJob(KEY, DATA, ROUTING);
    const changed = { ...DATA, payload: { ...DATA.payload, device_id: 'device-2' } };
    expect(() => verifyBridgeLocalSig(KEY, signed.ts, signed.sig, changed, ROUTING)).toThrow();
  });

  it('rejects a changed BMC address', () => {
    const signed = signBridgeLocalJob(KEY, DATA, ROUTING);
    const changed = { ...DATA, payload: { ...DATA.payload, bmc_ip: '192.0.2.11' } };
    expect(() => verifyBridgeLocalSig(KEY, signed.ts, signed.sig, changed, ROUTING)).toThrow();
  });

  it('rejects a timestamp older than 300 seconds', () => {
    const signed = signBridgeLocalJob(KEY, DATA, ROUTING);
    vi.advanceTimersByTime(301_000);
    expect(() => verifyBridgeLocalSig(KEY, signed.ts, signed.sig, DATA, ROUTING)).toThrow();
  });

  it('rejects a timestamp more than 60 seconds in the future', () => {
    const signed = signBridgeLocalJob(KEY, DATA, ROUTING);
    vi.setSystemTime(new Date('2026-07-29T01:58:59Z'));
    expect(() => verifyBridgeLocalSig(KEY, signed.ts, signed.sig, DATA, ROUTING)).toThrow();
  });

  it('rejects a signature from a different key', () => {
    const signed = signBridgeLocalJob(Buffer.alloc(32, 2), DATA, ROUTING);
    expect(() => verifyBridgeLocalSig(KEY, signed.ts, signed.sig, DATA, ROUTING)).toThrow();
  });

  it('rejects corrupted ciphertext', () => {
    const envelope = sealBridgeLocalJob(KEY, DATA, ROUTING);
    const ciphertext = Buffer.from(String(envelope.__bridge_local_ciphertext), 'base64');
    ciphertext[0] ^= 1;
    envelope.__bridge_local_ciphertext = ciphertext.toString('base64');
    expect(() => openBridgeLocalJob(KEY, envelope, ROUTING)).toThrow();
  });

  it('rejects a nonce with the wrong length', () => {
    const envelope = sealBridgeLocalJob(KEY, DATA, ROUTING);
    envelope.__bridge_local_nonce = Buffer.alloc(11).toString('base64');
    expect(() => openBridgeLocalJob(KEY, envelope, ROUTING)).toThrow('Bridge-local encryption fields are invalid');
  });

  it('rejects a tag with the wrong length', () => {
    const envelope = sealBridgeLocalJob(KEY, DATA, ROUTING);
    envelope.__bridge_local_tag = Buffer.alloc(15).toString('base64');
    expect(() => openBridgeLocalJob(KEY, envelope, ROUTING)).toThrow('Bridge-local encryption fields are invalid');
  });

  it('rejects a missing nonce', () => {
    const envelope = sealBridgeLocalJob(KEY, DATA, ROUTING);
    delete envelope.__bridge_local_nonce;
    expect(() => openBridgeLocalJob(KEY, envelope, ROUTING)).toThrow('Bridge-local encryption fields are missing');
  });

  it('rejects an unsupported version', () => {
    const envelope = sealBridgeLocalJob(KEY, DATA, ROUTING);
    envelope.__bridge_local_v = 2;
    expect(() => openBridgeLocalJob(KEY, envelope, ROUTING)).toThrow('Bridge-local encryption fields are missing');
  });

  it('rejects a different encryption key', () => {
    const envelope = sealBridgeLocalJob(KEY, DATA, ROUTING);
    expect(() => openBridgeLocalJob(Buffer.alloc(32, 2), envelope, ROUTING)).toThrow();
  });

  it('rejects malformed decrypted JSON', () => {
    expect(() => openBridgeLocalJob(KEY, malformedJsonEnvelope(), ROUTING)).toThrow(SyntaxError);
  });

  it.each([
    { ...ROUTING, job_id: 'other-job' },
    { ...ROUTING, job_name: 'other.name' },
    { ...ROUTING, queue_name: 'other-queue' },
  ])('rejects changed routing fields', (routing) => {
    const envelope = sealBridgeLocalJob(KEY, DATA, ROUTING);
    expect(() => openBridgeLocalJob(KEY, envelope, routing)).toThrow();
  });
});
