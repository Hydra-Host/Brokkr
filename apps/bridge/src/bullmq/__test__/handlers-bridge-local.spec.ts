import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentNotConnected } from '../../agent/dispatch/grpc.exceptions.js';
import { SealedEnvelopeService } from '../../zone-crypto/sealed-envelope.service.js';
import { ZoneCryptoService } from '../../zone-crypto/zone-crypto.service.js';
import { sealBridgeLocalJob, signBridgeLocalJob } from '../bridge-local-sig.js';
import { BullmqProcessorService, CrossBridgeHandoff, type ProcessableJob } from '../handlers.service.js';
import { InboundEnvelopeOpenerService } from '../inbound-envelope.service.js';

const KEY = Buffer.alloc(32, 1);
const PLAIN_DATA = {
  plan_id: 'plan-1',
  saga_name: 'provision',
  device_id: 'device-1',
  payload: { device_id: 'device-1' },
};
const DATA = {
  ...PLAIN_DATA,
  __bridge_local: true,
};
const ROUTING = {
  job_id: 'device-1-provision-plan-1',
  job_name: 'saga.run',
  queue_name: 'lifecycle',
};

function zoneCrypto(active: boolean): ZoneCryptoService {
  const service = new ZoneCryptoService();
  service.clear();
  if (active) activate(service);
  return service;
}

function activate(service: ZoneCryptoService): void {
  service.set({
    zonePriv: KEY,
    zonePub: Buffer.alloc(32, 2),
    hubPub: Buffer.alloc(32, 3),
    enrolledAt: Date.now(),
  });
}

function job(
  data: Record<string, unknown>,
  moveToDelayed: ProcessableJob<unknown>['scripts']['moveToDelayed'] = async () => {},
): ProcessableJob<unknown> {
  return {
    id: ROUTING.job_id,
    name: 'saga.run',
    data,
    queue: { name: 'lifecycle', opts: {} },
    scripts: { moveToDelayed },
  };
}

function opener(zone: ZoneCryptoService): InboundEnvelopeOpenerService {
  return new InboundEnvelopeOpenerService(
    new SealedEnvelopeService(zone),
    zone,
    { getZoneId: () => 'zone-1' },
    { error: async () => {} },
    'collection',
  );
}

function signedPlaintextData(): Record<string, unknown> {
  const signed = signBridgeLocalJob(KEY, DATA, ROUTING);
  return {
    ...DATA,
    __bridge_local_ts: signed.ts,
    __bridge_local_sig: signed.sig,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-29T02:00:00Z'));
});

afterEach(() => {
  new ZoneCryptoService().clear();
  vi.useRealTimers();
});

describe('bridge-local inbound jobs', () => {
  it('accepts a valid encrypted payload', async () => {
    const data = sealBridgeLocalJob(KEY, PLAIN_DATA, ROUTING);
    await expect(opener(zoneCrypto(true)).open(job(data))).resolves.toEqual({
      payload: PLAIN_DATA,
      createdAtMs: Date.now(),
      isBridgeLocal: true,
    });
  });

  it('rejects an invalid signature', async () => {
    const data = sealBridgeLocalJob(KEY, PLAIN_DATA, ROUTING);
    data.__bridge_local_sig = '0'.repeat(64);
    await expect(opener(zoneCrypto(true)).open(job(data))).rejects.toThrow();
  });

  it('rejects a stale signature', async () => {
    const data = sealBridgeLocalJob(KEY, PLAIN_DATA, ROUTING);
    vi.advanceTimersByTime(301_000);
    await expect(opener(zoneCrypto(true)).open(job(data))).rejects.toThrow();
  });

  it('accepts an unsigned job before zone activation', async () => {
    await expect(opener(zoneCrypto(false)).open(job(DATA))).resolves.toEqual({
      payload: DATA,
      createdAtMs: Date.now(),
      isBridgeLocal: true,
    });
  });

  it('rejects an unsigned job after zone activation', async () => {
    const zone = zoneCrypto(false);
    const service = opener(zone);
    await expect(service.open(job(DATA))).resolves.toEqual({
      payload: DATA,
      createdAtMs: Date.now(),
      isBridgeLocal: true,
    });
    activate(zone);
    await expect(service.open(job(DATA))).rejects.toThrow('Bridge-local signature fields are missing');
  });

  it('stores a fresh encrypted payload when it delays a bridge-local job', async () => {
    const moveToDelayed = vi.fn<ProcessableJob<unknown>['scripts']['moveToDelayed']>(async () => {});
    const zone = zoneCrypto(true);
    const processor = new BullmqProcessorService(
      {
        'saga.run': async () => {
          throw new AgentNotConnected('device-1');
        },
      },
      {
        open: async (input) => ({ payload: input.data, createdAtMs: Date.now(), isBridgeLocal: true }),
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      zone,
    );
    const input = job(PLAIN_DATA, moveToDelayed);
    vi.advanceTimersByTime(10_000);
    await expect(processor.process(input, 'token')).rejects.toBeInstanceOf(CrossBridgeHandoff);
    const options = moveToDelayed.mock.calls[0][4];
    const stored: Record<string, unknown> = JSON.parse(String(options.fieldsToUpdate.data));
    expect(stored).toMatchObject({
      __bridge_local: true,
      __bridge_local_ts: String(Math.floor(Date.now() / 1000)),
    });
    expect(stored.__bridge_local_sig).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain('"plan_id":"plan-1"');
    await expect(opener(zone).open(job(stored))).resolves.toEqual({
      payload: PLAIN_DATA,
      createdAtMs: Date.now(),
      isBridgeLocal: true,
    });
  });

  it('rejects a stale signed job delayed while the zone is inactive', async () => {
    const moveToDelayed = vi.fn<ProcessableJob<unknown>['scripts']['moveToDelayed']>(async () => {});
    const zone = zoneCrypto(false);
    const processor = new BullmqProcessorService(
      {
        'saga.run': async () => {
          throw new AgentNotConnected('device-1');
        },
      },
      {
        open: async () => ({ payload: DATA, createdAtMs: Date.now(), isBridgeLocal: true }),
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      zone,
    );
    const data = signedPlaintextData();
    await expect(processor.process(job(data, moveToDelayed), 'token')).rejects.toBeInstanceOf(CrossBridgeHandoff);
    expect(moveToDelayed.mock.calls[0][4].fieldsToUpdate).toEqual({});
    vi.advanceTimersByTime(301_000);
    activate(zone);
    await expect(opener(zone).open(job(data))).rejects.toThrow(
      'Bridge-local signature timestamp is outside the allowed window',
    );
  });
});
