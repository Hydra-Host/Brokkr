import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { HostPluginNetplanRenderer } from '../host-plugin-netplan-renderer';
import { NetplanService } from '../netplan.service';

const DEVICE_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('HostPluginNetplanRenderer', () => {
  it('passes device and phase to the host renderer', async () => {
    const renderForDevice = vi.fn().mockResolvedValue('network:\n  version: 2\n');
    const module = await Test.createTestingModule({
      providers: [HostPluginNetplanRenderer, { provide: NetplanService, useValue: { renderForDevice } }],
    }).compile();

    await expect(
      module.get(HostPluginNetplanRenderer).renderForDevice({ deviceId: DEVICE_ID, phase: 'deploy' }),
    ).resolves.toEqual({ yaml: 'network:\n  version: 2\n' });
    expect(renderForDevice).toHaveBeenCalledWith(DEVICE_ID, 'deploy');
  });
});
