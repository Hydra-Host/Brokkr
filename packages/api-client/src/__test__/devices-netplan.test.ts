import { describe, expect, it } from 'vitest';
import { devicesNetplanRoutes } from '../contract/devices-netplan';
import { DeviceNetplanQuerySchema, DeviceNetplanResponseSchema } from '../schemas/devices-netplan';
import { ErrorResponseSchema } from '../schemas/responses';

describe('device Netplan contract', () => {
  it('defaults to live and accepts deploy', () => {
    expect(DeviceNetplanQuerySchema.parse({})).toEqual({ phase: 'live' });
    expect(DeviceNetplanQuerySchema.parse({ phase: 'deploy' })).toEqual({ phase: 'deploy' });
    expect(DeviceNetplanQuerySchema.safeParse({ phase: 'other' }).success).toBe(false);
  });

  it('requires non-empty YAML', () => {
    expect(DeviceNetplanResponseSchema.safeParse({ yaml: '' }).success).toBe(false);
    expect(DeviceNetplanResponseSchema.safeParse({ yaml: 'network:\n  version: 2\n' }).success).toBe(true);
  });

  it('documents incomplete render context as 422', () => {
    const { responses } = devicesNetplanRoutes.getDeviceNetplan;
    expect(responses[200]).toBe(DeviceNetplanResponseSchema);
    expect(responses[403]).toBe(ErrorResponseSchema);
    expect(responses[404]).toBe(ErrorResponseSchema);
    expect(responses[422]).toBe(ErrorResponseSchema);
  });
});
