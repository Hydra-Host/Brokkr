import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation, InterfaceUpsert } from '../collector.types';
import { type IbDataInput, ibDataSchema, ibPortSchema } from './ib_data.schema';

@Injectable()
export class IbDataHandler implements CollectorHandler<IbDataInput> {
  readonly name = 'ib_data' as const;
  readonly schema = ibDataSchema;

  async handle(input: IbDataInput): Promise<DeviceMutation> {
    const interfaces: InterfaceUpsert[] = [];
    const warnings: string[] = [];

    input.forEach((raw, idx) => {
      const parsed = ibPortSchema.safeParse(raw);
      if (!parsed.success) {
        warnings.push(`ib_data[${idx}] malformed`);
        return;
      }
      const port = parsed.data;
      const linkType = (port.link_type ?? '').toLowerCase();
      interfaces.push({
        name: port.mlx5_name,
        guid: port.guid,
        linkType: linkType === 'infiniband' ? 'INFINIBAND' : linkType === 'ethernet' ? 'ETHERNET' : null,
        portState: port.port_state ?? null,
        pciDeviceId: port.pci_device_id ?? null,
        maxSpeedGbps: port.max_speed_gbps ?? null,
        linkOperUp: port.link_oper_up ?? null,
        linkPhysicalUp: port.link_physical_up ?? null,
      });
    });

    return {
      upserts: interfaces.length ? { interfaces } : undefined,
      warnings: warnings.length ? warnings : undefined,
    };
  }
}
