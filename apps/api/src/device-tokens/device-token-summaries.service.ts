import { Inject, Injectable } from '@nestjs/common';
import type { DeviceTokenSummary } from '@repo/api-client';
import { deviceTokenSummary } from '@repo/device-domain';
import { ContextService } from 'src/common/context/context.service';
import { BaremetalRecord } from 'src/devices/baremetal.record';
import { DeviceTokensService } from './device-tokens.service';

@Injectable()
export class DeviceTokenSummariesService {
  constructor(
    @Inject(DeviceTokensService) private readonly tokens: Pick<DeviceTokensService, 'listForDevice'>,
    @Inject(ContextService) private readonly contextService: Pick<ContextService, 'requirePermission'>,
  ) {}

  async list(deviceId: string): Promise<DeviceTokenSummary[]> {
    await BaremetalRecord.findByDeviceIdOrThrow(deviceId);
    this.contextService.requirePermission('device-token', 'access');
    const rows = await this.tokens.listForDevice(deviceId);
    return rows.map(deviceTokenSummary);
  }
}
