import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation, DeviceSolConfigUpsert } from '../collector.types';
import { type SerialPortsInput, serialPortsSchema } from './serial_ports.schema';

@Injectable()
export class SerialPortsHandler implements CollectorHandler<SerialPortsInput> {
  readonly name = 'serial_ports' as const;
  readonly schema = serialPortsSchema;

  async handle(input: SerialPortsInput): Promise<DeviceMutation> {
    const sol = input.bmc_sol_hardware;
    const rec = input.hardware_recommendations;
    const resolved = input.resolved;

    const solConfig: DeviceSolConfigUpsert = {
      solCapable: sol.sol_capable ?? null,
      solEnabled: sol.sol_enabled ?? null,
      hardwareChannel: sol.hardware_channel ?? null,
      baudRate: sol.hardware_baud_rate ?? rec.recommended_baud ?? null,
      port: sol.hardware_port ?? null,
      encryptionCapable: sol.encryption_capable ?? null,
      optimalPort: rec.optimal_port ?? null,
      bmcChannelMapping: rec.bmc_channel_mapping ?? null,
      resolvedPort: resolved?.port ?? null,
      resolvedBaud: resolved?.baud ?? null,
      resolvedSource: resolved?.source ?? null,
      resolvedConfirmed: resolved?.confirmed ?? null,
      availablePorts: input.ports ? Object.keys(input.ports) : [],
    };

    return { upserts: { solConfig } };
  }
}
