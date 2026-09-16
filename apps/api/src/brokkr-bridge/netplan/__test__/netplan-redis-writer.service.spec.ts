import { Test, TestingModule } from '@nestjs/testing';
import { ConfigAtomWriter, NETPLAN_LIVE_TTL_SECONDS, netplanConfig } from 'src/common/redis';
import { Mock, vi } from 'vitest';
import { NetplanAtomSchema } from '../netplan-atom.schema';
import { NetplanRedisWriterService } from '../netplan-redis-writer.service';

describe('NetplanRedisWriterService', () => {
  let service: NetplanRedisWriterService;
  let writeAtomJson: Mock;
  let deleteKeys: Mock;
  const DEVICE_UUID = '11111111-2222-3333-4444-555555555555';

  beforeEach(async () => {
    writeAtomJson = vi.fn().mockResolvedValue({ written: true });
    deleteKeys = vi.fn().mockResolvedValue(undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NetplanRedisWriterService,
        { provide: ConfigAtomWriter, useValue: { writeAtomJson, deleteKeys } },
        {
          provide: `LoggerService${NetplanRedisWriterService.name}`,
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

    service = module.get<NetplanRedisWriterService>(NetplanRedisWriterService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes the live netplan as an envelope under the 20-minute TTL using NetplanAtomSchema', async () => {
    await service.set('1-1-1', DEVICE_UUID, 'live', 'network:\n  version: 2\n');
    expect(writeAtomJson).toHaveBeenCalledWith(
      '1-1-1',
      netplanConfig(DEVICE_UUID, 'live'),
      { yaml: 'network:\n  version: 2\n' },
      NetplanAtomSchema,
      NETPLAN_LIVE_TTL_SECONDS,
      { request_id: null },
    );
  });

  it('writes the deploy netplan as an envelope under the 20-minute TTL using NetplanAtomSchema', async () => {
    await service.set('1-1-1', DEVICE_UUID, 'deploy', 'network:\n  version: 2\n');
    expect(writeAtomJson).toHaveBeenCalledWith(
      '1-1-1',
      netplanConfig(DEVICE_UUID, 'deploy'),
      { yaml: 'network:\n  version: 2\n' },
      NetplanAtomSchema,
      NETPLAN_LIVE_TTL_SECONDS,
      { request_id: null },
    );
  });

  it('deletes the deploy netplan key via the atom writer', async () => {
    await service.deleteDeploy('1-1-1', DEVICE_UUID);
    expect(deleteKeys).toHaveBeenCalledWith('1-1-1', [netplanConfig(DEVICE_UUID, 'deploy')]);
  });

  it('deletes the live netplan key via the atom writer', async () => {
    await service.deleteLive('1-1-1', DEVICE_UUID);
    expect(deleteKeys).toHaveBeenCalledWith('1-1-1', [netplanConfig(DEVICE_UUID, 'live')]);
  });

  it('surfaces a contextual error when writeAtomJson rejects', async () => {
    writeAtomJson.mockRejectedValueOnce(new Error('redis down'));
    await expect(service.set('1-1-1', DEVICE_UUID, 'live', 'network:\n  version: 2\n')).rejects.toThrow('redis down');
  });

  it('surfaces a contextual error when deleteKeys rejects', async () => {
    deleteKeys.mockRejectedValueOnce(new Error('redis down'));
    await expect(service.deleteDeploy('1-1-1', DEVICE_UUID)).rejects.toThrow('redis down');
  });

  it('surfaces a contextual error when deleteKeys rejects for the live key', async () => {
    deleteKeys.mockRejectedValueOnce(new Error('redis down'));
    await expect(service.deleteLive('1-1-1', DEVICE_UUID)).rejects.toThrow('redis down');
  });

  it('surfaces the write result (no throw) when writeAtomJson reports a stale envelope', async () => {
    writeAtomJson.mockResolvedValueOnce({ written: false, reason: 'stale' });
    await expect(service.set('1-1-1', DEVICE_UUID, 'live', 'network:\n  version: 2\n')).resolves.toEqual({
      written: false,
      reason: 'stale',
    });
  });

  it('surfaces the write result on a successful write', async () => {
    writeAtomJson.mockResolvedValueOnce({ written: true });
    await expect(service.set('1-1-1', DEVICE_UUID, 'live', 'network:\n  version: 2\n')).resolves.toEqual({
      written: true,
    });
  });
});
