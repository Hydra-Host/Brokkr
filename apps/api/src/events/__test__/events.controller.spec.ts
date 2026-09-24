import { Subject } from 'rxjs';
import { ContextService } from 'src/common/context/context.service';
import { LoggerService } from 'src/logger/logger.service';
import { describe, expect, it } from 'vitest';
import { EventsController } from '../events.controller';
import { DEVICE_METADATA_UPDATED, JOB_EVENT_RECORDED, type DeviceEvent } from '../events.types';
import { RedisPubSubService } from '../redis-pubsub.service';

function makeEvent(organizationId: string | null, deviceId: string, supplierId: string | null = null): DeviceEvent {
  return {
    type: DEVICE_METADATA_UPDATED,
    deviceId,
    deploymentId: null,
    organizationId,
    supplierId,
    status: 'inventory',
    powerStatus: null,
  };
}

function makeJobEvent(organizationId: string | null, deviceId: string, supplierId: string | null = null): DeviceEvent {
  return {
    type: JOB_EVENT_RECORDED,
    deviceId,
    deploymentId: 'dep-1',
    organizationId,
    supplierId,
    jobId: 'job-1',
    phase: 'RUNNING',
  };
}

function setup(organizationId: string | null, viewer: { operator?: boolean; jobRead?: boolean } = {}) {
  const deviceEvents$ = new Subject<DeviceEvent>();
  const redisPubSub = { deviceEvents$ } as unknown as RedisPubSubService;
  const contextService = {
    identity: organizationId ? { organizationId } : undefined,
    isInstanceOperator: viewer.operator ?? false,
    hasPermission: () => viewer.jobRead ?? false,
  } as unknown as ContextService;
  const logger = { log: () => {} } as unknown as LoggerService;
  const controller = new EventsController(redisPubSub, contextService, logger);

  const received: string[] = [];
  const types: string[] = [];
  controller.streamDeviceEvents().subscribe((msg) => {
    const frame = JSON.parse(msg.data);
    received.push(frame.deviceId);
    types.push(frame.type);
  });
  return { deviceEvents$, received, types };
}

describe('EventsController.streamDeviceEvents', () => {
  it('delivers only the subscriber org events; never null-org pool devices', () => {
    const { deviceEvents$, received } = setup('org-a');

    deviceEvents$.next(makeEvent(null, 'pool-device'));
    deviceEvents$.next(makeEvent('org-b', 'other-org-device'));
    deviceEvents$.next(makeEvent('org-a', 'own-device'));

    expect(received).toEqual(['own-device']);
  });

  it('delivers all events to an unscoped subscriber', () => {
    const { deviceEvents$, received } = setup(null);

    deviceEvents$.next(makeEvent(null, 'pool-device'));
    deviceEvents$.next(makeEvent('org-b', 'other-org-device'));

    expect(received).toEqual(['pool-device', 'other-org-device']);
  });

  it('delivers an event whose supplierId matches the subscriber org', () => {
    const { deviceEvents$, received } = setup('org-supplier');
    deviceEvents$.next(makeEvent('org-customer', 'rented-device', 'org-supplier'));
    deviceEvents$.next(makeEvent('org-customer', 'foreign-device', 'org-other'));
    expect(received).toEqual(['rented-device']);
  });

  it('delivers job step frames to an operator with job read regardless of org scope', () => {
    const { deviceEvents$, types } = setup('org-operator', { operator: true, jobRead: true });
    deviceEvents$.next(makeJobEvent('org-customer', 'rented-device', 'org-supplier'));
    expect(types).toEqual([JOB_EVENT_RECORDED]);
  });

  it('withholds job step frames from a customer or supplier member while metadata frames still arrive', () => {
    const { deviceEvents$, types } = setup('org-supplier');
    deviceEvents$.next(makeJobEvent('org-customer', 'rented-device', 'org-supplier'));
    deviceEvents$.next(makeEvent('org-customer', 'rented-device', 'org-supplier'));
    expect(types).toEqual([DEVICE_METADATA_UPDATED]);
  });

  it('withholds job step frames another organization requested from an operator without job read', () => {
    const { deviceEvents$, types } = setup('org-operator', { operator: true, jobRead: false });
    deviceEvents$.next(makeJobEvent('org-customer', 'rented-device', null));
    expect(types).toEqual([]);
  });

  it('never puts organizationId or supplierId on the wire', () => {
    const deviceEvents$ = new Subject<DeviceEvent>();
    const redisPubSub = { deviceEvents$ } as unknown as RedisPubSubService;
    const contextService = { identity: undefined } as unknown as ContextService;
    const logger = { log: () => {} } as unknown as LoggerService;
    const controller = new EventsController(redisPubSub, contextService, logger);
    const frames: Record<string, unknown>[] = [];
    controller.streamDeviceEvents().subscribe((msg) => frames.push(JSON.parse(msg.data)));
    deviceEvents$.next(makeEvent('org-a', 'd-1', 'org-b'));
    expect(frames[0]).toEqual({
      type: DEVICE_METADATA_UPDATED,
      deviceId: 'd-1',
      deploymentId: null,
      status: 'inventory',
      powerStatus: null,
    });
  });
});
