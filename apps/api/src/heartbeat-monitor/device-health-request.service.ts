import { Inject, Injectable } from '@nestjs/common';
import type { RequestDeviceHealthCheckResponse } from '@repo/api-client';
import { ContextService } from 'src/common/context/context.service';
import { BaremetalRecord } from 'src/devices/baremetal.record';
import { HealthCheckDispatcher } from './health-check-dispatcher';

@Injectable()
export class DeviceHealthRequestService {
  constructor(
    @Inject(HealthCheckDispatcher) private readonly dispatcher: Pick<HealthCheckDispatcher, 'dispatch'>,
    @Inject(ContextService) private readonly contextService: Pick<ContextService, 'requirePermission'>,
  ) {}

  async request(deviceId: string): Promise<RequestDeviceHealthCheckResponse> {
    await BaremetalRecord.findByDeviceIdOrThrow(deviceId);
    this.contextService.requirePermission('device', 'health-check');
    return this.dispatcher.dispatch(deviceId);
  }
}
