import { ClusterProviderRegistry, PLUGIN_EVENT_BUS } from '@hydrahost/plugin-sdk';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ZoneNetworkType } from '@repo/database';
import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClusterNetworkService } from '../cluster-network.service';

describe('ClusterNetworkService', () => {
  const prisma = {
    device: { findUnique: vi.fn() },
    deployment: { findUnique: vi.fn() },
    clusterDeployment: { findFirst: vi.fn() },
  };
  const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  const provider = { provider: 'netris', attach: vi.fn(), detach: vi.fn() };

  let service: ClusterNetworkService;

  beforeEach(async () => {
    vi.clearAllMocks();
    prisma.device.findUnique.mockResolvedValue({
      zoneId: 'zone-1',
      zone: { networkType: ZoneNetworkType.VPC },
      server: { vpcCapable: true },
    });
    prisma.deployment.findUnique.mockResolvedValue({ customerId: 'org-1' });
    prisma.clusterDeployment.findFirst.mockResolvedValue({ cluster: { provider: 'netris' } });
    vi.spyOn(ClusterProviderRegistry, 'resolve').mockReturnValue(provider);
    vi.spyOn(ClusterProviderRegistry, 'list').mockReturnValue([provider]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ClusterNetworkService,
        { provide: PrismaClient, useValue: prisma },
        { provide: PLUGIN_EVENT_BUS, useValue: eventBus },
        {
          provide: 'LoggerServiceClusterNetworkService',
          useValue: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        },
      ],
    }).compile();

    service = moduleRef.get(ClusterNetworkService);
  });

  it('fails closed on attach when a clusterable device has no deployment id', async () => {
    await expect(service.attach('', 'device-1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails closed on attach when a clusterable device deployment cannot be resolved', async () => {
    prisma.deployment.findUnique.mockResolvedValueOnce(null);

    await expect(service.attach('dep-missing', 'device-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps detach best-effort when deployment cannot be resolved', async () => {
    prisma.deployment.findUnique.mockResolvedValueOnce(null);

    await expect(service.detach('dep-missing', 'device-1')).resolves.toBeUndefined();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('falls back to the only registered provider when cluster membership is missing on detach', async () => {
    prisma.clusterDeployment.findFirst.mockResolvedValueOnce(null);

    await expect(service.detach('dep-1', 'device-1')).resolves.toBeUndefined();

    expect(provider.detach).toHaveBeenCalledWith({
      deploymentId: 'dep-1',
      deviceId: 'device-1',
      organizationId: 'org-1',
    });
  });
});
