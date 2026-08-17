import { Test } from '@nestjs/testing';
import { LifecyclePreparationService } from 'src/brokkr-bridge/lifecycle/lifecycle-preparation.service';
import { BridgeProvisionService } from 'src/brokkr-bridge/lifecycle/provision.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProvisionDispatcher } from '../operations/provision-dispatch';

describe('ProvisionDispatcher', () => {
  const lifecyclePrep = { prepareForProvision: vi.fn().mockResolvedValue(undefined) };
  const bridgeProvision = { provisionDevice: vi.fn().mockResolvedValue(undefined) };

  let dispatcher: ProvisionDispatcher;

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ProvisionDispatcher,
        { provide: LifecyclePreparationService, useValue: lifecyclePrep },
        { provide: BridgeProvisionService, useValue: bridgeProvision },
      ],
    }).compile();
    dispatcher = moduleRef.get(ProvisionDispatcher);
  });

  it('prepares the device, decodes cloud-init, and enqueues the provision saga', async () => {
    const cloudInit = Buffer.from(JSON.stringify({ users: ['root'] })).toString('base64');

    await dispatcher.dispatch({
      deviceId: 'device-1',
      jobId: 'job-1',
      deploymentName: 'my-box',
      operatingSystemSlug: 'ubuntu-22',
      diskLayouts: [{ mountpoint: '/' }],
      pubkeys: ['ssh-ed25519 AAA'],
      cloudInit,
      ipxeUrl: null,
      customizations: ['cuda-12'],
      passwordHash: 'hashed-pw',
      deploymentId: 'dep-1',
    });

    expect(lifecyclePrep.prepareForProvision).toHaveBeenCalledWith('device-1', 'job-1');
    expect(bridgeProvision.provisionDevice).toHaveBeenCalledWith(
      'device-1',
      'job-1',
      'provisioning',
      {
        hostname: 'my-box',
        diskLayouts: [{ mountpoint: '/' }],
        pubkeys: ['ssh-ed25519 AAA'],
        userData: { users: ['root'] },
        ipxeUrl: null,
        passwordHash: 'hashed-pw',
        customizations: ['cuda-12'],
      },
      'ubuntu-22',
      'dep-1',
    );
  });

  it('forwards an explicit reprovisioning status to the bridge (selective preserve, not a full wipe)', async () => {
    await dispatcher.dispatch({
      deviceId: 'device-1',
      jobId: 'job-1',
      deploymentName: 'my-box',
      operatingSystemSlug: 'ubuntu-22',
      diskLayouts: [{ mountpoint: '/' }],
      pubkeys: [],
      cloudInit: null,
      ipxeUrl: null,
      customizations: null,
      passwordHash: null,
      deploymentId: 'dep-1',
      status: 'reprovisioning',
    });

    expect(bridgeProvision.provisionDevice).toHaveBeenCalledWith(
      'device-1',
      'job-1',
      'reprovisioning',
      expect.any(Object),
      'ubuntu-22',
      'dep-1',
    );
  });

  it('defaults to provisioning (full wipe) when status is omitted — fail safe toward sanitizing', async () => {
    await dispatcher.dispatch({
      deviceId: 'device-1',
      jobId: 'job-1',
      deploymentName: 'my-box',
      operatingSystemSlug: 'ubuntu-22',
      diskLayouts: [],
      pubkeys: [],
      cloudInit: null,
      ipxeUrl: null,
      customizations: null,
      passwordHash: null,
      deploymentId: null,
    });

    expect(bridgeProvision.provisionDevice).toHaveBeenCalledWith(
      'device-1',
      'job-1',
      'provisioning',
      expect.any(Object),
      'ubuntu-22',
      null,
    );
  });

  it('passes null userData when there is no cloud-init', async () => {
    await dispatcher.dispatch({
      deviceId: 'device-1',
      jobId: 'job-1',
      deploymentName: 'my-box',
      operatingSystemSlug: 'ubuntu-22',
      diskLayouts: [],
      pubkeys: [],
      cloudInit: null,
      ipxeUrl: 'http://ipxe',
      customizations: null,
      passwordHash: null,
      deploymentId: null,
    });

    expect(bridgeProvision.provisionDevice).toHaveBeenCalledWith(
      'device-1',
      'job-1',
      'provisioning',
      expect.objectContaining({ userData: null, ipxeUrl: 'http://ipxe' }),
      'ubuntu-22',
      null,
    );
  });
});
