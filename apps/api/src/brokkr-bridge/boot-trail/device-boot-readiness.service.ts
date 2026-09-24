import { Inject, Injectable } from '@nestjs/common';
import type { DeviceBootReadiness } from '@repo/api-client';
import { deviceBootReadiness, ServerSpecHelper } from '@repo/device-domain';
import { BaremetalRecord } from 'src/devices/baremetal.record';
import { PrefixBootReadinessService } from 'src/ipam/prefix/prefix-boot-readiness.service';
import { PrefixRepository } from 'src/ipam/prefix/prefix.repository';
import { BootTrailService } from './boot-trail.service';

@Injectable()
export class DeviceBootReadinessService {
  constructor(
    @Inject(BootTrailService) private readonly bootTrail: Pick<BootTrailService, 'readForRecord'>,
    @Inject(PrefixRepository)
    private readonly prefixRepository: Pick<PrefixRepository, 'findBootPrefixForDevice'>,
    @Inject(PrefixBootReadinessService)
    private readonly prefixReadiness: Pick<PrefixBootReadinessService, 'check'>,
  ) {}

  async evaluate(deviceId: string): Promise<DeviceBootReadiness> {
    const record = await BaremetalRecord.findByDeviceIdOrThrow(deviceId);
    const bmcAddress = ServerSpecHelper.ipmiIp(record.data);
    const trail = await this.bootTrail.readForRecord(record);

    const selected =
      trail.zoneId === null ? null : await this.prefixRepository.findBootPrefixForDevice(deviceId, trail.zoneId);
    const prefixFindings =
      selected !== null && trail.pxeMac !== null
        ? (await this.prefixReadiness.check(selected.id, { mac: trail.pxeMac, bmcAddress: bmcAddress ?? undefined }))
            .findings
        : null;

    return deviceBootReadiness({
      deviceId,
      subject: record.data.name ?? deviceId,
      bmcAddress,
      trail,
      selected,
      prefixFindings,
    });
  }
}
