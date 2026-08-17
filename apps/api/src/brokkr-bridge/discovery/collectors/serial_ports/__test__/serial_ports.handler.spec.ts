import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SerialPortsHandler } from '../serial_ports.handler';

const fixture = (name: string) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../../__fixtures__/serial_ports', `${name}.json`), 'utf8'));

describe('SerialPortsHandler', () => {
  const handler = new SerialPortsHandler();

  it('upserts a DeviceSolConfig from a SOL-capable fixture', async () => {
    const parsed = handler.schema.parse(fixture('happy'));
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.solConfig).toEqual({
      solCapable: true,
      solEnabled: true,
      hardwareChannel: 1,
      baudRate: 115200,
      port: 2,
      encryptionCapable: true,
      optimalPort: 'ttyS1',
      bmcChannelMapping: 'BMC hardware channel 1',
      resolvedPort: null,
      resolvedBaud: null,
      resolvedSource: null,
      resolvedConfirmed: null,
      availablePorts: [],
    });
  });

  it('emits all-null config when bmc_sol_hardware and recommendations are empty', async () => {
    const parsed = handler.schema.parse(fixture('empty-sol'));
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.solConfig).toEqual({
      solCapable: null,
      solEnabled: null,
      hardwareChannel: null,
      baudRate: null,
      port: null,
      encryptionCapable: null,
      optimalPort: null,
      bmcChannelMapping: null,
      resolvedPort: null,
      resolvedBaud: null,
      resolvedSource: null,
      resolvedConfirmed: null,
      availablePorts: [],
    });
  });

  it('falls back to recommended_baud when sol hardware does not report one', async () => {
    const parsed = handler.schema.parse({
      bmc_sol_hardware: { sol_capable: true, hardware_channel: 1 },
      hardware_recommendations: { recommended_baud: 57600 },
    });
    const mutation = await handler.handle(parsed);
    expect(mutation.upserts?.solConfig?.baudRate).toBe(57600);
  });

  it('persists the resolved probe answer + availablePorts into the resolved columns', async () => {
    const parsed = handler.schema.parse({
      bmc_sol_hardware: { sol_capable: true, hardware_baud_rate: 115200 },
      ports: { ttyS0: { hardware_line: 0 }, ttyS1: { hardware_line: 1 } },
      resolved: { port: 'ttyS1', baud: 115200, source: 'vendor_table', confirmed: false },
    });
    const sol = (await handler.handle(parsed)).upserts?.solConfig;
    expect(sol?.resolvedPort).toBe('ttyS1');
    expect(sol?.resolvedBaud).toBe(115200);
    expect(sol?.resolvedSource).toBe('vendor_table');
    expect(sol?.resolvedConfirmed).toBe(false);
    expect(sol?.availablePorts).toEqual(['ttyS0', 'ttyS1']);
  });
});
