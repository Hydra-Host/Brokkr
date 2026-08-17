import { describe, expect, it, vi } from 'vitest';

import { ContextLogger } from '../../logger/logger.service';
import {
  EFI_BOOT_DISPATCH,
  EFI_BOOT_LOGGER,
  EFI_BOOT_SERVICE_FACTORY,
  EfiBootService,
  EfiBootServiceError,
  EfiBootServiceFactory,
  OS_BOOT_ENTRY_KEYWORDS,
  type EfiBootDispatchFn,
} from '../efi-boot.service';

const JOB_ID = 'test-job-123';
const DEVICE_ID = 'device-456';

function makeLogger(): ContextLogger {
  return new ContextLogger();
}

function makeService(dispatch: EfiBootDispatchFn, jobId = JOB_ID, deviceId = DEVICE_ID): EfiBootService {
  return new EfiBootService(jobId, deviceId, dispatch, makeLogger());
}

describe('EfiBootService — initialization', () => {
  it('captures jobId and deviceId; initial boot state is null', () => {
    const service = makeService(vi.fn());
    expect(service.jobId).toBe(JOB_ID);
    expect(service.deviceId).toBe(DEVICE_ID);
    expect(service.bootCurrent).toBeNull();
    expect(service.bootOrder).toBeNull();
    expect(service.bootOptions).toBeNull();
    expect(service.bootNext).toBeNull();
  });
});

describe('EfiBootService.getBootMenu', () => {
  it('dispatches system.getEfiBootMenu with a 30s timeout and captures state', async () => {
    const dispatch = vi.fn().mockResolvedValue({
      boot_current: '0001',
      boot_order: ['0001', '0002'],
      boot_options: { '0001': 'ubuntu' },
      boot_next: '0002',
    });
    const service = makeService(dispatch);

    const menu = await service.getBootMenu();

    expect(dispatch).toHaveBeenCalledWith(DEVICE_ID, 'system.getEfiBootMenu', {}, { jobId: JOB_ID, timeoutS: 30 });
    expect(menu).toEqual({
      boot_current: '0001',
      boot_order: ['0001', '0002'],
      boot_options: { '0001': 'ubuntu' },
      boot_next: '0002',
    });
    expect(service.bootCurrent).toBe('0001');
    expect(service.bootOrder).toEqual(['0001', '0002']);
    expect(service.bootOptions).toEqual({ '0001': 'ubuntu' });
    expect(service.bootNext).toBe('0002');
  });

  it('defaults null response fields to null', async () => {
    const dispatch = vi.fn().mockResolvedValue({
      boot_current: null,
      boot_order: null,
      boot_options: null,
      boot_next: null,
    });
    const service = makeService(dispatch);

    const menu = await service.getBootMenu();

    expect(menu.boot_current).toBeNull();
    expect(menu.boot_order).toBeNull();
    expect(menu.boot_options).toBeNull();
    expect(menu.boot_next).toBeNull();
  });

  it('wraps dispatch errors in EfiBootServiceError', async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error('agent down'));
    const service = makeService(dispatch);

    await expect(service.getBootMenu()).rejects.toThrow(EfiBootServiceError);
    await expect(service.getBootMenu()).rejects.toThrow(/Failed to get EFI boot menu/);
  });
});

describe('EfiBootService.removeBootEntry', () => {
  it('dispatches system.removeEfiBootEntry with the boot id payload', async () => {
    const dispatch = vi.fn().mockResolvedValue({ success: true });
    const service = makeService(dispatch);

    const ok = await service.removeBootEntry('0003');

    expect(ok).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(
      DEVICE_ID,
      'system.removeEfiBootEntry',
      { boot_id: '0003' },
      { jobId: JOB_ID, timeoutS: 30 },
    );
  });

  it('returns false when a boundary validation failure is swallowed (agent must assert success)', async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error('OUTPUT_VALIDATION'));
    const service = makeService(dispatch);

    expect(await service.removeBootEntry('0003')).toBe(false);
  });

  it('returns false when the agent reports success=false', async () => {
    const dispatch = vi.fn().mockResolvedValue({ success: false });
    const service = makeService(dispatch);

    expect(await service.removeBootEntry('0003')).toBe(false);
  });

  it('returns false on dispatch failure (swallowed)', async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error('agent down'));
    const service = makeService(dispatch);

    expect(await service.removeBootEntry('0003')).toBe(false);
  });
});

describe('EfiBootService.forceBootDevice', () => {
  it('dispatches system.forceBootDevice with a 60s timeout and records final state', async () => {
    const dispatch = vi.fn().mockResolvedValue({
      boot_current: '0001',
      boot_order: ['0001'],
      entries_removed: 3,
    });
    const service = makeService(dispatch);

    await service.forceBootDevice();

    expect(dispatch).toHaveBeenCalledWith(DEVICE_ID, 'system.forceBootDevice', {}, { jobId: JOB_ID, timeoutS: 60 });
    expect(service.bootCurrent).toBe('0001');
    expect(service.bootOrder).toEqual(['0001']);
  });

  it('tolerates null boot_current/boot_order (no-op fast path) without throwing', async () => {
    const dispatch = vi.fn().mockResolvedValue({ boot_current: null, boot_order: null, entries_removed: 0 });
    const service = makeService(dispatch);

    await expect(service.forceBootDevice()).resolves.toBeUndefined();
    expect(service.bootCurrent).toBeNull();
    expect(service.bootOrder).toBeNull();
  });

  it('wraps dispatch errors in EfiBootServiceError', async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error('agent down'));
    const service = makeService(dispatch);

    await expect(service.forceBootDevice()).rejects.toThrow(EfiBootServiceError);
    await expect(service.forceBootDevice()).rejects.toThrow(/Force boot device failed/);
  });

  it('null boot_current/boot_order triggers the missing-info warning', async () => {
    const dispatch = vi.fn().mockResolvedValue({
      boot_current: null,
      boot_order: null,
      entries_removed: 0,
    });
    const logger = {
      debug: vi.fn().mockResolvedValue(undefined),
      info: vi.fn().mockResolvedValue(undefined),
      warning: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
    };
    const service = new EfiBootService(JOB_ID, DEVICE_ID, dispatch, logger);

    await service.forceBootDevice();
    expect(logger.warning).toHaveBeenCalledWith('Missing boot current or boot order information', { jobId: JOB_ID });
  });
});

describe('EfiBootService.cleanupOsBootEntries', () => {
  it('dispatches system.cleanupOsBootEntries with a 60s timeout', async () => {
    const dispatch = vi.fn().mockResolvedValue({ removed: ['ubuntu', 'proxmox'], count: 2 });
    const service = makeService(dispatch);

    const result = await service.cleanupOsBootEntries();

    expect(dispatch).toHaveBeenCalledWith(
      DEVICE_ID,
      'system.cleanupOsBootEntries',
      {},
      { jobId: JOB_ID, timeoutS: 60 },
    );
    expect(result).toEqual({ removed: ['ubuntu', 'proxmox'], count: 2 });
  });

  it('returns an empty list when the agent yields no removals', async () => {
    const dispatch = vi.fn().mockResolvedValue({ removed: [], count: 0 });
    const service = makeService(dispatch);

    const result = await service.cleanupOsBootEntries();
    expect(result).toEqual({ removed: [], count: 0 });
  });

  it('wraps dispatch errors in EfiBootServiceError', async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error('agent down'));
    const service = makeService(dispatch);

    await expect(service.cleanupOsBootEntries()).rejects.toThrow(EfiBootServiceError);
    await expect(service.cleanupOsBootEntries()).rejects.toThrow(/Failed to clean up OS boot entries/);
  });
});

describe('EfiBootServiceFactory', () => {
  it('create returns a service bound to {jobId, deviceId}', async () => {
    const dispatch = vi.fn();
    const factory = new EfiBootServiceFactory(dispatch, makeLogger());

    const service = await factory.create({ jobId: 'j1', deviceId: 'd1' });

    expect(service).toBeInstanceOf(EfiBootService);
    expect(service.jobId).toBe('j1');
    expect(service.deviceId).toBe('d1');
  });

  it('created service uses the factory-supplied dispatch fn', async () => {
    const dispatch = vi.fn().mockResolvedValue({ removed: [], count: 0 });
    const factory = new EfiBootServiceFactory(dispatch, makeLogger());
    const service = await factory.create({ jobId: 'j1', deviceId: 'd1' });

    await service.cleanupOsBootEntries();
    expect(dispatch).toHaveBeenCalledWith('d1', 'system.cleanupOsBootEntries', {}, { jobId: 'j1', timeoutS: 60 });
  });

  it('default logger is the injected ContextLogger', async () => {
    const dispatch = vi.fn().mockResolvedValue({ removed: [], count: 0 });
    const factory = new EfiBootServiceFactory(dispatch, makeLogger());
    const service = await factory.create({ jobId: '', deviceId: 'd1' });
    await expect(service.cleanupOsBootEntries()).resolves.toBeDefined();
  });

  it('explicit logger is honored — every log surface forwards', async () => {
    const dispatch = vi.fn().mockResolvedValue({ removed: ['ubuntu'], count: 1 });
    const logger = makeLogger();
    const infoSpy = vi.spyOn(logger, 'info').mockResolvedValue(undefined);
    const factory = new EfiBootServiceFactory(dispatch, logger);
    const service = await factory.create({ jobId: 'j1', deviceId: 'd1' });

    await service.cleanupOsBootEntries();
    expect(infoSpy).toHaveBeenCalled();
  });
});

describe('module surface', () => {
  it('exports the OS boot-entry keyword set used by the agent cleanup op', () => {
    expect(OS_BOOT_ENTRY_KEYWORDS).toEqual(['ubuntu', 'debian', 'proxmox', 'ipxe disk']);
  });

  it('exposes the canonical DI tokens', () => {
    expect(typeof EFI_BOOT_DISPATCH).toBe('symbol');
    expect(typeof EFI_BOOT_LOGGER).toBe('symbol');
    expect(typeof EFI_BOOT_SERVICE_FACTORY).toBe('symbol');
  });
});
