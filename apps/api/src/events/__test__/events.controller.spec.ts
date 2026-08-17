import { Subject } from 'rxjs';
import { ContextService } from 'src/common/context/context.service';
import { LoggerService } from 'src/logger/logger.service';
import { describe, expect, it } from 'vitest';
import { EventsController } from '../events.controller';
import { DeviceMetadataUpdatedEvent } from '../events.types';
import { RedisPubSubService } from '../redis-pubsub.service';

function makeEvent(organizationId: string | null, deviceId: string): DeviceMetadataUpdatedEvent {
  return { deviceId, deploymentId: null, organizationId, status: 'inventory', powerStatus: null };
}

function setup(organizationId: string | null) {
  const deviceEvents$ = new Subject<DeviceMetadataUpdatedEvent>();
  const redisPubSub = { deviceEvents$ } as unknown as RedisPubSubService;
  const contextService = {
    identity: organizationId ? { organizationId } : undefined,
  } as unknown as ContextService;
  const logger = { log: () => {} } as unknown as LoggerService;
  const controller = new EventsController(redisPubSub, contextService, logger);

  const received: string[] = [];
  controller.streamDeviceEvents().subscribe((msg) => {
    received.push(JSON.parse(msg.data).deviceId);
  });
  return { deviceEvents$, received };
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
});
