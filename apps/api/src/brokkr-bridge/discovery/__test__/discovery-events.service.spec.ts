import type { EventEmitter2 } from '@nestjs/event-emitter';
import { describe, expect, it, vi } from 'vitest';
import { DiscoveryEventsService } from '../discovery-events.service';
import { DiscoveryEvent } from '../discovery.events';

describe('DiscoveryEventsService', () => {
  it('forwards emit calls to EventEmitter2 with the event name + payload', () => {
    const emitter = { emit: vi.fn() } as unknown as EventEmitter2;
    const service = new DiscoveryEventsService(emitter);

    service.emit(DiscoveryEvent.RunStarted, {
      runId: 'r1',
      deviceId: 'd1',
      jobId: 'j1',
      zonePrefix: 'z1',
      startedAt: new Date('2026-01-01T00:00:00Z'),
    });

    expect(emitter.emit).toHaveBeenCalledTimes(1);
    expect(emitter.emit).toHaveBeenCalledWith(
      DiscoveryEvent.RunStarted,
      expect.objectContaining({ runId: 'r1', deviceId: 'd1' }),
    );
  });

  it('handles completed payloads with storage layouts', () => {
    const emitter = { emit: vi.fn() } as unknown as EventEmitter2;
    const service = new DiscoveryEventsService(emitter);

    service.emit(DiscoveryEvent.RunCompleted, {
      runId: 'r1',
      deviceId: 'd1',
      zonePrefix: 'z1',
      jobId: 'j1',
      storageLayouts: { configs: [] },
      rawBundle: {},
      collectorsApplied: ['bmc', 'lsblk'],
      collectorsSkipped: [],
      composersApplied: ['tee'],
      issueCount: 0,
      durationMs: 123,
    });

    expect(emitter.emit).toHaveBeenCalledWith(
      DiscoveryEvent.RunCompleted,
      expect.objectContaining({ collectorsApplied: ['bmc', 'lsblk'] }),
    );
  });
});
