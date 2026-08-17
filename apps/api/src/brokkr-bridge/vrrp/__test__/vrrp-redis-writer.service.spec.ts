import { Test, TestingModule } from '@nestjs/testing';
import { ConfigAtomWriter, TTL_VRRP_VIP_SECONDS, vrrpConfig } from 'src/common/redis';
import { Mock, vi } from 'vitest';
import { VrrpAtomSchema } from '../vrrp-atom.schema';
import { VrrpRedisWriterService } from '../vrrp-redis-writer.service';

describe('VrrpRedisWriterService', () => {
  let service: VrrpRedisWriterService;
  let writeAtomJson: Mock;
  let delKey: Mock;
  const ZONE = '99999999-0000-0000-0000-000000000000';
  const PREFIX_ID = '11111111-2222-3333-4444-555555555555';
  const IFACE = 'eth0';
  const IFACE_BY_BRIDGE: Record<string, string> = { 'bridge-a': IFACE };

  beforeEach(async () => {
    writeAtomJson = vi.fn().mockResolvedValue({ written: true });
    delKey = vi.fn().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VrrpRedisWriterService,
        { provide: ConfigAtomWriter, useValue: { writeAtomJson, delKey } },
        {
          provide: `LoggerService${VrrpRedisWriterService.name}`,
          useValue: {
            log: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            verbose: vi.fn(),
            setContext: vi.fn().mockReturnThis(),
          },
        },
      ],
    }).compile();

    service = module.get<VrrpRedisWriterService>(VrrpRedisWriterService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes the VIP and ifaceByBridge map as an envelope under the durable (0) TTL using VrrpAtomSchema', async () => {
    await service.set(ZONE, PREFIX_ID, '10.0.1.1/24', IFACE_BY_BRIDGE, 5);
    expect(writeAtomJson).toHaveBeenCalledWith(
      ZONE,
      vrrpConfig(PREFIX_ID),
      { vip: '10.0.1.1/24', ifaceByBridge: IFACE_BY_BRIDGE, garpCount: 5 },
      VrrpAtomSchema,
      TTL_VRRP_VIP_SECONDS,
      { request_id: null },
    );
  });

  it('deletes the VIP key via the atom writer', async () => {
    await service.clear(ZONE, PREFIX_ID);
    expect(delKey).toHaveBeenCalledWith(ZONE, vrrpConfig(PREFIX_ID));
  });

  it('surfaces the write result (no throw) when the envelope is stale', async () => {
    writeAtomJson.mockResolvedValueOnce({ written: false, reason: 'stale' });
    await expect(service.set(ZONE, PREFIX_ID, '10.0.1.1/24', IFACE_BY_BRIDGE, 5)).resolves.toEqual({
      written: false,
      reason: 'stale',
    });
  });

  it('surfaces a contextual error when writeAtomJson rejects', async () => {
    writeAtomJson.mockRejectedValueOnce(new Error('redis down'));
    await expect(service.set(ZONE, PREFIX_ID, '10.0.1.1/24', IFACE_BY_BRIDGE, 5)).rejects.toThrow('redis down');
  });
});
