import { BaremetalRecord } from 'src/devices/baremetal.record';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceTokenSummariesService } from '../device-token-summaries.service';

const DEVICE = '22222222-2222-2222-2222-222222222222';

const token = {
  id: 't-1',
  deviceId: DEVICE,
  deploymentId: null,
  context: 'BROKKR_LIVE',
  displayId: 'ab12',
  status: 'ACTIVE',
  rotationGeneration: 0,
  expiresAt: null,
  lastUsedAt: new Date('2026-09-16T11:57:00.000Z'),
  lastUsedIp: '10.40.1.23',
  revokedAt: null,
  revokedReason: null,
  revokedNote: 'internal note',
  issuedBy: 'user:1',
  createdAt: new Date('2026-09-15T10:00:00.000Z'),
  updatedAt: new Date('2026-09-16T11:57:00.000Z'),
};

describe('DeviceTokenSummariesService.list', () => {
  afterEach(() => vi.restoreAllMocks());

  it('pins the device, requires the permission and drops the operator-only fields', async () => {
    const pin = vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue({
      data: { id: DEVICE },
    } as unknown as BaremetalRecord);
    const tokens = { listForDevice: vi.fn().mockResolvedValue([token]) };
    const contextService = { requirePermission: vi.fn() };
    const service = new DeviceTokenSummariesService(tokens as never, contextService as never);
    const out = await service.list(DEVICE);
    expect(pin).toHaveBeenCalledWith(DEVICE);
    expect(contextService.requirePermission).toHaveBeenCalledWith('device-token', 'access');
    expect(out).toHaveLength(1);
    expect(Object.keys(out[0]!).sort()).toEqual(
      [
        'context',
        'createdAt',
        'deviceId',
        'displayId',
        'expiresAt',
        'id',
        'lastUsedAt',
        'lastUsedIp',
        'revokedAt',
        'revokedReason',
        'rotationGeneration',
        'status',
      ].sort(),
    );
  });

  it('checks the permission before reading tokens', async () => {
    vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow').mockResolvedValue({
      data: { id: DEVICE },
    } as unknown as BaremetalRecord);
    const tokens = { listForDevice: vi.fn() };
    const contextService = {
      requirePermission: vi.fn(() => {
        throw new Error('denied');
      }),
    };
    const service = new DeviceTokenSummariesService(tokens as never, contextService as never);
    await expect(service.list(DEVICE)).rejects.toThrow('denied');
    expect(tokens.listForDevice).not.toHaveBeenCalled();
  });
});
