import { RequestSource } from '@repo/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostPluginLifecycleRequests } from '../host-plugin-lifecycle-requests';
import type { LifecycleService } from '../lifecycle.service';

const JOB = {
  data: { id: 'job-1', jobType: 'Provision', phase: 'DISPATCHED' },
};

const DISK_LAYOUT = {
  config: 'direct',
  format: 'ext4' as const,
  mountpoint: '/',
  diskType: 'NVMe',
  disks: ['nvme0n1'],
  wipe: true,
};

describe('HostPluginLifecycleRequests', () => {
  const lifecycle = {
    requestProvisionAsOperator: vi.fn().mockResolvedValue(JOB),
    requestProvision: vi.fn().mockResolvedValue(JOB),
    requestReprovision: vi.fn().mockResolvedValue(JOB),
    requestDeprovision: vi.fn().mockResolvedValue(JOB),
    requestDeprovisionWithoutDeployment: vi.fn().mockResolvedValue(JOB),
    requestReboot: vi.fn().mockResolvedValue(JOB),
    requestPowerControl: vi.fn().mockResolvedValue(JOB),
  };

  let adapter: HostPluginLifecycleRequests;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new HostPluginLifecycleRequests(lifecycle as unknown as LifecycleService);
  });

  it('routes requestProvision through requestProvisionAsOperator (not requestProvision)', async () => {
    const ref = await adapter.requestProvision({
      deviceId: 'device-1',
      userId: 'user-1',
      organizationId: 'org-1',
      deploymentName: 'box',
      operatingSystemSlug: 'ubuntu-22.04',
      sshKeyIds: ['11111111-1111-4111-8111-111111111111'],
      diskLayouts: [DISK_LAYOUT],
      cloudInit: null,
      ipxeUrl: null,
      customizations: null,
      source: RequestSource.UI,
    });

    expect(lifecycle.requestProvisionAsOperator).toHaveBeenCalled();
    expect(lifecycle.requestProvision).not.toHaveBeenCalled();
    expect(ref).toEqual({ jobId: 'job-1', jobType: 'Provision', phase: 'DISPATCHED' });
  });

  it('forwards retry attribution beside the engine request, not inside it', async () => {
    await adapter.requestProvision({
      deviceId: 'device-1',
      userId: 'user-1',
      organizationId: 'org-1',
      deploymentName: 'box',
      operatingSystemSlug: 'ubuntu-22.04',
      sshKeyIds: ['11111111-1111-4111-8111-111111111111'],
      diskLayouts: [DISK_LAYOUT],
      cloudInit: null,
      ipxeUrl: null,
      customizations: null,
      source: RequestSource.UI,
      retriedFromJobId: 'job-old',
      retriedBy: 'operator-1',
      triggeredByEmail: 'op@hydrahost.test',
    });

    expect(lifecycle.requestProvisionAsOperator).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'device-1', userId: 'user-1' }),
      { retriedFromJobId: 'job-old', retriedBy: 'operator-1', triggeredByEmail: 'op@hydrahost.test' },
    );
    const [engineRequest] = lifecycle.requestProvisionAsOperator.mock.calls[0];
    expect(engineRequest).not.toHaveProperty('retriedFromJobId');
    expect(engineRequest).not.toHaveProperty('retriedBy');
  });

  it('forwards retryReason in the audit payload', async () => {
    await adapter.requestProvision({
      deviceId: 'device-1',
      userId: 'user-1',
      organizationId: 'org-1',
      deploymentName: 'box',
      operatingSystemSlug: 'ubuntu-22.04',
      sshKeyIds: ['11111111-1111-4111-8111-111111111111'],
      diskLayouts: [DISK_LAYOUT],
      cloudInit: null,
      ipxeUrl: null,
      customizations: null,
      source: RequestSource.UI,
      retriedFromJobId: 'job-old',
      retriedBy: 'operator-1',
      retryReason: 'BMC hung',
      triggeredByEmail: 'op@hydrahost.test',
    });

    expect(lifecycle.requestProvisionAsOperator).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'device-1', userId: 'user-1' }),
      {
        retriedFromJobId: 'job-old',
        retriedBy: 'operator-1',
        retryReason: 'BMC hung',
        triggeredByEmail: 'op@hydrahost.test',
      },
    );
    const [engineRequest] = lifecycle.requestProvisionAsOperator.mock.calls[0];
    expect(engineRequest).not.toHaveProperty('retryReason');
  });

  it('does not attach retryReason without the retry pair', async () => {
    await adapter.requestProvision({
      deviceId: 'device-1',
      userId: 'user-1',
      organizationId: 'org-1',
      deploymentName: 'box',
      operatingSystemSlug: 'ubuntu-22.04',
      sshKeyIds: ['11111111-1111-4111-8111-111111111111'],
      diskLayouts: [DISK_LAYOUT],
      cloudInit: null,
      ipxeUrl: null,
      customizations: null,
      source: RequestSource.UI,
      retryReason: 'BMC hung',
      triggeredByEmail: 'op@hydrahost.test',
    });

    expect(lifecycle.requestProvisionAsOperator).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'device-1', userId: 'user-1' }),
      { triggeredByEmail: 'op@hydrahost.test' },
    );
  });

  it('rejects a bad operatingSystemSlug before calling the engine', async () => {
    await expect(
      adapter.requestReprovision({
        deviceId: 'device-1',
        userId: 'user-1',
        organizationId: 'org-1',
        deploymentName: 'box',
        operatingSystemSlug: 'NOT VALID',
        sshKeyIds: ['11111111-1111-4111-8111-111111111111'],
        diskLayouts: [DISK_LAYOUT],
        cloudInit: null,
        ipxeUrl: null,
        customizations: null,
        source: RequestSource.UI,
      }),
    ).rejects.toThrow();
    expect(lifecycle.requestReprovision).not.toHaveBeenCalled();
  });

  it('rejects a bad diskLayouts entry before calling the engine', async () => {
    await expect(
      adapter.requestReprovision({
        deviceId: 'device-1',
        userId: 'user-1',
        organizationId: 'org-1',
        deploymentName: 'box',
        operatingSystemSlug: 'ubuntu-22.04',
        sshKeyIds: ['11111111-1111-4111-8111-111111111111'],
        diskLayouts: [{ ...DISK_LAYOUT, mountpoint: '/data; rm -rf /' }],
        cloudInit: null,
        ipxeUrl: null,
        customizations: null,
        source: RequestSource.UI,
      }),
    ).rejects.toThrow();
    expect(lifecycle.requestReprovision).not.toHaveBeenCalled();
  });

  it('rejects an invalid RequestSource on deprovision', async () => {
    const invalid = JSON.parse(
      JSON.stringify({
        deviceId: 'device-1',
        userId: 'user-1',
        organizationId: 'org-1',
        source: 'NOT_A_SOURCE',
      }),
    );
    await expect(adapter.requestDeprovision(invalid)).rejects.toThrow();
    expect(lifecycle.requestDeprovision).not.toHaveBeenCalled();
  });

  it('maps a successful deprovision to a job ref', async () => {
    const ref = await adapter.requestDeprovision({
      deviceId: 'device-1',
      userId: 'user-1',
      organizationId: 'org-1',
      source: RequestSource.UI,
      gateOverride: true,
    });
    expect(lifecycle.requestDeprovision).toHaveBeenCalledWith(
      expect.objectContaining({ source: RequestSource.UI, gateOverride: true }),
    );
    expect(ref.jobId).toBe('job-1');
  });

  it('maps a successful lifecycle deprovision (no deployment) to a job ref', async () => {
    const ref = await adapter.requestLifecycleDeprovision({
      deviceId: 'device-1',
      userId: 'user-1',
      source: RequestSource.UI,
    });
    expect(lifecycle.requestDeprovisionWithoutDeployment).toHaveBeenCalledWith({
      deviceId: 'device-1',
      userId: 'user-1',
      source: RequestSource.UI,
      triggeredByEmail: undefined,
    });
    expect(lifecycle.requestDeprovision).not.toHaveBeenCalled();
    expect(ref.jobId).toBe('job-1');
  });
});
