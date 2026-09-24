import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deviceRecordSchema, type DeviceRecord } from '../../device-record/device-record.schema';
import { ResolveOutcome } from '../../device-record/device-record.service';
import { logInfo } from '../../logger/logger.service';

import { renderForRecord } from '../chain-decision';
import type { RendererSpy, RenderForRecordContext } from '../chain.types';
import { IpxeDeployTokenUnavailableError } from '../ipxe-errors';
import type { RenderRequest } from '../ipxe-renderer.helpers';

vi.mock('../../logger/logger.service', () => ({
  logInfo: vi.fn(async () => {}),
  logWarning: vi.fn(async () => {}),
}));

const DEVICE_UUID = '12121212-1212-1212-1212-121212121212';

const mockedLogInfo = vi.mocked(logInfo);

function record(overrides: Partial<DeviceRecord> = {}): DeviceRecord {
  return deviceRecordSchema.parse({
    id: DEVICE_UUID,
    status: 'provisioning',
    role: 'server',
    installed_os: 'ipxe-custom-tee',
    rescue_os: null,
    platform_tags: [],
    device_type: 'poweredge-r750',
    netplan: null,
    serial_port_recommended: null,
    last_job_id: null,
    buildarch: 'amd64',
    ...overrides,
  });
}

function renderer(): RendererSpy {
  return {
    render_discovery: async () => 'discovery script',
    render_disk: async () => 'disk script',
    render_unknown: async () => 'unknown script',
    render_retry: async () => 'retry script',
    render_custom: async () => 'custom script',
  };
}

const request: RenderRequest = { platform: 'efi-amd64', buildarch: 'x86_64', mac_address: 'aa:bb:cc:dd:ee:ff' };

function context(overrides: Partial<RenderForRecordContext> = {}): RenderForRecordContext {
  return {
    record: record(),
    request,
    jobId: 'job-1',
    discoveryFlavors: ['full'],
    renderer: renderer(),
    ...overrides,
  };
}

function loggedMessages(): string[] {
  return mockedLogInfo.mock.calls.map((call) => String(call[0]));
}

describe('chain decision render logging', () => {
  beforeEach(() => {
    mockedLogInfo.mockClear();
  });

  it('names render_custom with the device id when the boot marker is present', async () => {
    await renderForRecord(context({ redisIpxeUrl: 'https://customer.example/boot.ipxe' }));

    expect(loggedMessages()).toEqual([`iPXE render: render_custom for device ${DEVICE_UUID}`]);
    expect(mockedLogInfo.mock.calls[0]?.[1]).toEqual({ jobId: 'job-1', deviceId: DEVICE_UUID });
  });

  it('names render_disk when the boot marker is absent', async () => {
    await renderForRecord(context({ redisIpxeUrl: null }));

    expect(loggedMessages()).toEqual([`iPXE render: render_disk for device ${DEVICE_UUID}`]);
    expect(mockedLogInfo.mock.calls[0]?.[1]).toEqual({ jobId: 'job-1', deviceId: DEVICE_UUID });
  });

  it('names only the served method when render_custom throws and falls back to render_retry', async () => {
    const failingRenderer: RendererSpy = {
      ...renderer(),
      render_custom: async () => {
        throw new IpxeDeployTokenUnavailableError('no deploy token');
      },
    };

    const result = await renderForRecord(
      context({ redisIpxeUrl: 'https://customer.example/boot.ipxe', renderer: failingRenderer }),
    );

    expect(result).toBe('retry script');
    expect(loggedMessages()).toEqual([`iPXE render: render_retry for device ${DEVICE_UUID}`]);
  });

  it('serves the script even when the render log throws', async () => {
    mockedLogInfo.mockRejectedValueOnce(new Error('log sink unavailable'));

    await expect(renderForRecord(context({ redisIpxeUrl: null }))).resolves.toBe('disk script');
  });

  it('logs a device-less render path without a device id', async () => {
    await renderForRecord(context({ record: ResolveOutcome.KNOWN_RECORD_MISSING }));

    expect(loggedMessages()).toEqual(['iPXE render: render_retry for device unknown']);
    expect(mockedLogInfo.mock.calls[0]?.[1]).toEqual({ jobId: 'job-1', deviceId: undefined });
  });
});
