import { describe, expect, it } from 'vitest';

import {
  IN_FLIGHT_LIST_STATES,
  IN_FLIGHT_ZSET_STATES,
  parseSagaJobId,
  QUEUE_LIST_STATES,
  QUEUE_SET_STATES,
  QUEUE_ZSET_STATES,
  queueKey,
  RESULTS_QUEUE_NAME,
  RESULTS_QUEUE_PREFIX,
  SAGA_QUEUE_NAMES,
} from '../saga-topology';

const DEVICE = '00000000-0000-0000-0000-000000000001';
const PLAN = '3f2a1c4e-8b7d-4e6f-9a0b-1c2d3e4f5a6b';

describe('queueKey', () => {
  it('joins prefix, name and suffix with colons', () => {
    expect(queueKey('zone-a', 'lifecycle', 'wait')).toBe('zone-a:lifecycle:wait');
  });

  it('builds the global results inbox key', () => {
    expect(queueKey(RESULTS_QUEUE_PREFIX, RESULTS_QUEUE_NAME, 'active')).toBe('results:inbox:active');
  });

  it('passes a glob suffix through untouched', () => {
    expect(queueKey('bull', 'device-status-effects', `device-${DEVICE}-*`)).toBe(
      `bull:device-status-effects:device-${DEVICE}-*`,
    );
  });
});

describe('parseSagaJobId', () => {
  it('splits a device / saga / plan triple', () => {
    expect(parseSagaJobId(`${DEVICE}-provision-${PLAN}`)).toEqual({
      deviceId: DEVICE,
      sagaName: 'provision',
      planId: PLAN,
    });
  });

  it('reports a null plan id for the collection-queue form', () => {
    expect(parseSagaJobId(`${DEVICE}-inventory_collection`)).toEqual({
      deviceId: DEVICE,
      sagaName: 'inventory_collection',
      planId: null,
    });
  });

  it.each(['device_health_check', 'enrich_via_pxe'])('keeps underscores in the saga name: %s', (sagaName) => {
    expect(parseSagaJobId(`${DEVICE}-${sagaName}-${PLAN}`)).toEqual({ deviceId: DEVICE, sagaName, planId: PLAN });
  });

  it('keeps a hyphenated saga name intact', () => {
    expect(parseSagaJobId(`${DEVICE}-power-cycle-${PLAN}`)).toEqual({
      deviceId: DEVICE,
      sagaName: 'power-cycle',
      planId: PLAN,
    });
  });

  it('accepts an uppercase-hex device id', () => {
    const upper = DEVICE.toUpperCase();
    expect(parseSagaJobId(`${upper}-provision`)).toEqual({ deviceId: upper, sagaName: 'provision', planId: null });
  });

  it('attributes the device on an inventory-cron coalesce key', () => {
    expect(parseSagaJobId(`inventory-cron-${DEVICE}`)).toEqual({ deviceId: DEVICE, sagaName: null, planId: null });
  });

  it('attributes the device on a health-cron coalesce key', () => {
    expect(parseSagaJobId(`health-cron-${DEVICE}`)).toEqual({ deviceId: DEVICE, sagaName: null, planId: null });
  });

  it('attributes the device on a device-status-effects job id', () => {
    expect(parseSagaJobId(`device-${DEVICE}-PROVISIONING-1730000000000`)).toEqual({
      deviceId: DEVICE,
      sagaName: null,
      planId: null,
    });
  });

  it('takes the first uuid when the id buries more than one', () => {
    expect(parseSagaJobId(`prefixed-${DEVICE}-${PLAN}`)).toEqual({ deviceId: DEVICE, sagaName: null, planId: null });
  });

  it('returns null when no segment is a uuid', () => {
    expect(parseSagaJobId('device-1-provision')).toBeNull();
    expect(parseSagaJobId('leader_heartbeat')).toBeNull();
  });

  it('returns null for the empty string', () => {
    expect(parseSagaJobId('')).toBeNull();
  });

  it('returns null for a bare uuid with no suffix', () => {
    expect(parseSagaJobId(DEVICE)).toBeNull();
  });
});

describe('saga queue topology', () => {
  it('names both per-zone saga queues', () => {
    expect(SAGA_QUEUE_NAMES).toEqual(['lifecycle', 'collection']);
  });

  it('groups every bullmq state by its backing redis type', () => {
    expect(QUEUE_LIST_STATES).toEqual(['wait', 'active', 'paused']);
    expect(QUEUE_ZSET_STATES).toEqual(['delayed', 'completed', 'failed', 'waiting-children', 'prioritized']);
    expect(QUEUE_SET_STATES).toEqual(['stalled']);
  });

  it('declares the in-flight subsets independently of the display vocabulary', () => {
    expect(IN_FLIGHT_LIST_STATES).not.toBe(QUEUE_LIST_STATES);
    expect(IN_FLIGHT_ZSET_STATES).not.toBe(QUEUE_ZSET_STATES);
  });

  it('narrows the in-flight subsets to members of their full groups', () => {
    expect(IN_FLIGHT_LIST_STATES).toEqual(['wait', 'active', 'paused']);
    expect(IN_FLIGHT_ZSET_STATES).toEqual(['delayed', 'prioritized']);
    for (const state of IN_FLIGHT_LIST_STATES) expect(QUEUE_LIST_STATES).toContain(state);
    for (const state of IN_FLIGHT_ZSET_STATES) expect(QUEUE_ZSET_STATES).toContain(state);
  });
});
