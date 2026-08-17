import { HttpException } from '@nestjs/common';
import { AdminLifecycleRequestStatus, AdminLifecycleRequestType } from '@repo/database';
import { mockDeploymentLifecycleActionWithUser } from 'src/prisma/fixtures';
import { RESCUE_OS_SLUG } from 'src/provision/provision.types';
import { describe, expect, it } from 'vitest';
import { DeploymentPresenter } from '../deployment.presenter';
import { createMockDeploymentAggregate } from './fixtures';

describe('DeploymentPresenter', () => {
  describe('toResponse', () => {
    it('returns formatted deployment data', () => {
      const aggregate = createMockDeploymentAggregate({
        nickname: 'My GPU Server',
        customerId: 'customer-123',
        scheduledInterruptionTime: new Date('2023-01-01T00:00:00.000Z'),
        createdAt: new Date('2023-01-01T00:00:00.000Z'),
        lifecycleActions: [mockDeploymentLifecycleActionWithUser],
      });
      const result = DeploymentPresenter.toResponse(aggregate);

      expect(result).toMatchObject({
        id: aggregate.id,
        location: 'North America',
        status: { value: 'provisioned', label: 'Provisioned' },
        powerStatus: { value: 'Running', label: 'Running' },
        scheduledInterruptionTime: '2023-01-01T00:00:00.000Z',
        role: { slug: 'Baremetal' },
        customer: {
          deviceName: 'My GPU Server',
          organizationId: 'customer-123',
          provisionedDate: '2023-01-01T00:00:00.000Z',
          sshPubKeys: 'ssh-rsa AAAA...',
          sshPubKeysIds: 'key-123',
          userId: 'user-123',
        },
        networking: {
          ipv4: '1.2.3.4',
          ipv6: '2001:db8::1',
          mac: '00:11:22:33:44:55',
        },
        specs: {
          operating_system: 'Ubuntu 20.04',
          cpu: {
            coresPerCpu: 8,
            count: 2,
            model: 'Intel Xeon',
            threadsPerCore: 2,
            threadsPerCpu: 16,
            totalCores: 16,
            totalThreads: 32,
          },
          gpu: { count: 4, model: 'NVIDIA A100' },
          memory: { total: 128 },
          storage: {
            hddCount: 2,
            hddSize: 1862,
            nvmeCount: 1,
            nvmeSize: 931,
            ssdCount: 1,
            ssdSize: 466,
            total: 3259,
          },
        },
        defaultDiskLayouts: [
          {
            config: 'lvm',
            format: 'ext4',
            mountpoint: '/',
            diskType: 'ssd',
            disks: ['0x3001438038d17d50', '0x3001438038d17d51'],
          },
        ],
        isTeeCapable: false,
        teeEnabled: false,
        project: {
          id: 'project-123',
          name: 'Test Project',
          createdAt: '2023-01-01T00:00:00.000Z',
          updatedAt: '2023-01-01T00:00:00.000Z',
        },
      });
    });

    it('passes base layers through from catalog without transformation', () => {
      const aggregate = createMockDeploymentAggregate();
      const catalog = {
        bases: [
          { id: 'l-1', slug: 'ubuntu-noble', name: 'Ubuntu Noble', family: 'base' },
          { id: 'l-2', slug: 'debian-bookworm', name: 'Debian Bookworm', family: 'base' },
        ],
        componentsByBase: {},
      };

      const result = DeploymentPresenter.toResponse(aggregate, catalog);

      expect(result.availableBaseLayers).toEqual([
        { id: 'l-1', slug: 'ubuntu-noble', name: 'Ubuntu Noble', family: 'base' },
        { id: 'l-2', slug: 'debian-bookworm', name: 'Debian Bookworm', family: 'base' },
      ]);
    });

    it('resolves status as "queued" when device is stale relative to latest provision action', () => {
      const staleDate = new Date('2023-01-01T00:00:00.000Z');
      const provisionDate = new Date('2023-01-02T00:00:00.000Z');

      const aggregate = createMockDeploymentAggregate({
        server: { lifecycleStatus: 'PROVISIONED', updatedAt: staleDate } as any,
        lifecycleActions: [
          { ...mockDeploymentLifecycleActionWithUser, actionType: 'Provision' as any, performedAt: provisionDate },
        ],
      });

      expect(DeploymentPresenter.toResponse(aggregate).status.value).toBe('queued');
    });

    it('does not override status when the server status is newer than the provision action', () => {
      const freshDate = new Date('2023-01-03T00:00:00.000Z');
      const provisionDate = new Date('2023-01-02T00:00:00.000Z');

      const aggregate = createMockDeploymentAggregate({
        server: { lifecycleStatus: 'PROVISIONED', updatedAt: freshDate } as any,
        lifecycleActions: [
          { ...mockDeploymentLifecycleActionWithUser, actionType: 'Provision' as any, performedAt: provisionDate },
        ],
      });

      expect(DeploymentPresenter.toResponse(aggregate).status.value).toBe('provisioned');
    });

    it('shows "provisioned" (not "queued") when device.updatedAt is stale but phone-home bumped server.updatedAt', () => {
      const dispatch = new Date('2026-06-30T19:13:21.014Z');
      const provisionAction = new Date('2026-06-30T19:13:21.074Z');
      const phoneHome = new Date('2026-06-30T19:17:14.726Z');

      const aggregate = createMockDeploymentAggregate({
        server: { lifecycleStatus: 'PROVISIONED', updatedAt: phoneHome, device: { updatedAt: dispatch } } as any,
        lifecycleActions: [
          { ...mockDeploymentLifecycleActionWithUser, actionType: 'Provision' as any, performedAt: provisionAction },
        ],
      });

      expect(DeploymentPresenter.toResponse(aggregate).status.value).toBe('provisioned');
    });

    it('surfaces "awaiting approval" when a DEFERRED lifecycle job is present', () => {
      const aggregate = createMockDeploymentAggregate({
        server: { lifecycleStatus: 'INVENTORY' } as any,
        lifecycleJobs: [{ id: 'job-1' }] as any,
      });
      const result = DeploymentPresenter.toResponse(aggregate);
      expect(result.status).toEqual({ value: 'awaiting_approval', label: 'Awaiting approval' });
    });

    it('awaiting-approval takes precedence over the device-derived status', () => {
      const aggregate = createMockDeploymentAggregate({
        server: { lifecycleStatus: 'PROVISIONED' } as any,
        lifecycleJobs: [{ id: 'job-1' }] as any,
      });
      expect(DeploymentPresenter.toResponse(aggregate).status.value).toBe('awaiting_approval');
    });

    it('computes total storage from individual storage drives', () => {
      const aggregate = createMockDeploymentAggregate({
        server: {
          device: {
            storageDrives: [
              { type: 'HDD', sizeBytes: BigInt(2_000_000_000_000) },
              { type: 'NVME', sizeBytes: BigInt(1_000_000_000_000) },
              { type: 'SSD', sizeBytes: BigInt(500_000_000_000) },
            ],
          },
        } as any,
      });
      const result = DeploymentPresenter.toResponse(aggregate);
      expect(result.specs.storage.total).toBe(3260);
    });

    it('preserves pre-sorted lifecycle actions order (sorted by Prisma)', () => {
      const newer = {
        ...mockDeploymentLifecycleActionWithUser,
        id: 'action-2',
        performedAt: new Date('2023-06-01'),
      };
      const older = {
        ...mockDeploymentLifecycleActionWithUser,
        id: 'action-1',
        performedAt: new Date('2023-01-01'),
      };

      const aggregate = createMockDeploymentAggregate({
        lifecycleActions: [newer, older],
      });
      const result = DeploymentPresenter.toResponse(aggregate);
      expect(result.lifecycleActions[0].id).toBe('action-2');
      expect(result.lifecycleActions[1].id).toBe('action-1');
    });

    it('projects only firstName and lastName for the ssh-key owner (no PII leak)', () => {
      const aggregate = createMockDeploymentAggregate();
      const result = DeploymentPresenter.toResponse(aggregate);

      expect(result.sshKeys).toHaveLength(1);
      const user = result.sshKeys[0].user;
      expect(user).toEqual({ firstName: 'John', lastName: 'Doe' });
      expect(Object.keys(user).sort()).toEqual(['firstName', 'lastName']);
      expect(user).not.toHaveProperty('email');
      expect(user).not.toHaveProperty('phoneNumber');
      expect(user).not.toHaveProperty('members');
    });
  });

  describe('isRescueModeEligible', () => {
    it('is eligible when the deployment is provisioned', () => {
      const aggregate = createMockDeploymentAggregate();
      expect(DeploymentPresenter.isRescueModeEligible(aggregate)).toBe(true);
    });

    it('is eligible when the deployment has failed', () => {
      const aggregate = createMockDeploymentAggregate({
        server: { lifecycleStatus: 'FAILED' } as never,
      });
      expect(DeploymentPresenter.isRescueModeEligible(aggregate)).toBe(true);
    });

    it.each(['PROVISIONING', 'DEPROVISIONING', 'REBOOTING', 'INVENTORY'])(
      'is NOT eligible mid-lifecycle (%s) so rescue cannot clobber the brokkr-discovery boot override',
      (lifecycleStatus) => {
        const aggregate = createMockDeploymentAggregate({
          server: { lifecycleStatus } as never,
        });
        expect(DeploymentPresenter.isRescueModeEligible(aggregate)).toBe(false);
      },
    );
  });

  describe('current_rescue_operating_system_name (slug gating)', () => {
    const rescueLayer = (slug: string) => ({
      id: 'rescue-1',
      slug,
      name: `Layer ${slug}`,
      family: 'live',
      kind: 'LIVE',
      layerGroupId: 'group-live',
      createdAt: new Date('2023-01-01T00:00:00.000Z'),
      updatedAt: new Date('2023-01-01T00:00:00.000Z'),
    });

    it('surfaces the name for a genuine customer rescue OS', () => {
      const aggregate = createMockDeploymentAggregate({ rescueLayer: rescueLayer(RESCUE_OS_SLUG) as never });
      expect(DeploymentPresenter.toResponse(aggregate).specs.current_rescue_operating_system_name).toBe(
        `Layer ${RESCUE_OS_SLUG}`,
      );
    });

    it('hides an internal boot override (brokkr-discovery) so it never renders as rescue mode', () => {
      const aggregate = createMockDeploymentAggregate({ rescueLayer: rescueLayer('brokkr-discovery') as never });
      expect(DeploymentPresenter.toResponse(aggregate).specs.current_rescue_operating_system_name).toBeUndefined();
    });
  });

  describe('lifecycleRequestsToJSON', () => {
    it('preserves pre-sorted request order (sorted by Prisma)', () => {
      const aggregate = createMockDeploymentAggregate({
        lifecycleRequests: [
          {
            id: 'req-2',
            deploymentId: 'deployment-123',
            type: 'REPROVISION' as any,
            status: 'APPROVED' as any,
            requestBody: {},
            requestedBy: { name: 'Admin' } as any,
            approvedAt: new Date('2023-06-02'),
            rejectedAt: null,
            executedAt: null,
            createdAt: new Date('2023-06-01'),
            approvedById: null,
          } as any,
          {
            id: 'req-1',
            deploymentId: 'deployment-123',
            type: 'DEPROVISION' as any,
            status: 'PENDING' as any,
            requestBody: {},
            requestedBy: { name: 'Admin' } as any,
            approvedAt: null,
            rejectedAt: null,
            executedAt: null,
            createdAt: new Date('2023-01-01'),
            approvedById: null,
          } as any,
        ],
      });

      const result = DeploymentPresenter.lifecycleRequestsToJSON(aggregate);
      expect(result[0].id).toBe('req-2');
      expect(result[1].id).toBe('req-1');
    });

    it('drops cross-tenant eviction requests so another org payload never leaks', () => {
      const aggregate = createMockDeploymentAggregate({
        customerId: 'customer-123',
        lifecycleRequests: [
          {
            id: 'eviction',
            deploymentId: 'deployment-123',
            type: 'DEPROVISION' as any,
            status: 'PENDING' as any,
            requestBody: {
              organizationId: 'incoming-org-999',
              userId: 'incoming-user',
              sshKeyIds: ['incoming-key'],
              cloudInit: 'write_files:\n  - content: SUPER_SECRET_TOKEN',
              passwordHash: '$6$incoming$hash',
            },
            requestedBy: { name: 'Incoming Tenant' } as any,
            approvedAt: null,
            rejectedAt: null,
            executedAt: null,
            createdAt: new Date('2023-02-01'),
            approvedById: null,
          } as any,
          {
            id: 'own',
            deploymentId: 'deployment-123',
            type: 'REPROVISION' as any,
            status: 'PENDING' as any,
            requestBody: { organizationId: 'customer-123' },
            requestedBy: { name: 'Owner Admin' } as any,
            approvedAt: null,
            rejectedAt: null,
            executedAt: null,
            createdAt: new Date('2023-01-01'),
            approvedById: null,
          } as any,
        ],
      });

      const result = DeploymentPresenter.lifecycleRequestsToJSON(aggregate);

      expect(result.map((r) => r.id)).toEqual(['own']);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('incoming-org-999');
      expect(serialized).not.toContain('SUPER_SECRET_TOKEN');
      expect(serialized).not.toContain('incoming-key');
      expect(serialized).not.toContain('Incoming Tenant');
    });
  });

  describe('findLifecycleRequestById', () => {
    it('returns the matching request', () => {
      const aggregate = createMockDeploymentAggregate({
        lifecycleRequests: [
          {
            id: 'req-1',
            deploymentId: 'deployment-123',
            type: 'DEPROVISION' as any,
            status: 'PENDING' as any,
            requestBody: {},
            requestedBy: { name: 'Admin' } as any,
            approvedAt: null,
            rejectedAt: null,
            executedAt: null,
            createdAt: new Date(),
            approvedById: null,
          } as any,
        ],
      });

      const result = DeploymentPresenter.findLifecycleRequestById(aggregate, 'req-1');
      expect(result).not.toBeNull();
      expect(result.id).toBe('req-1');
    });

    it('returns null when not found', () => {
      const aggregate = createMockDeploymentAggregate();
      const result = DeploymentPresenter.findLifecycleRequestById(aggregate, 'nonexistent');
      expect(result).toBeNull();
    });

    it('returns null for a cross-tenant eviction request even if the ID matches', () => {
      const aggregate = createMockDeploymentAggregate({
        customerId: 'customer-123',
        lifecycleRequests: [
          {
            id: 'eviction',
            deploymentId: 'deployment-123',
            type: 'DEPROVISION' as any,
            status: 'PENDING' as any,
            requestBody: { organizationId: 'incoming-org-999' },
            requestedBy: { name: 'Incoming Tenant' } as any,
            approvedAt: null,
            rejectedAt: null,
            executedAt: null,
            createdAt: new Date(),
            approvedById: null,
          } as any,
        ],
      });

      expect(DeploymentPresenter.findLifecycleRequestById(aggregate, 'eviction')).toBeNull();
    });
  });

  describe('getApprovedLifecycleRequestOrThrow', () => {
    it('returns the latest approved request of the given type', () => {
      const aggregate = createMockDeploymentAggregate({
        lifecycleRequests: [
          {
            id: 'req-1',
            deploymentId: 'deployment-123',
            type: AdminLifecycleRequestType.DEPROVISION,
            status: AdminLifecycleRequestStatus.APPROVED,
            requestBody: {},
            requestedBy: { name: 'Admin' } as any,
            approvedAt: new Date('2023-06-01'),
            rejectedAt: null,
            executedAt: null,
            createdAt: new Date(),
            approvedById: 'user-1',
          } as any,
        ],
      });

      const result = DeploymentPresenter.getApprovedLifecycleRequestOrThrow(
        aggregate,
        AdminLifecycleRequestType.DEPROVISION,
      );
      expect(result.id).toBe('req-1');
    });

    it('throws when no approved request exists', () => {
      const aggregate = createMockDeploymentAggregate({ lifecycleRequests: [] });

      expect(() =>
        DeploymentPresenter.getApprovedLifecycleRequestOrThrow(aggregate, AdminLifecycleRequestType.DEPROVISION),
      ).toThrow(HttpException);
    });
  });

  describe('extractSshKeys', () => {
    it('maps deployment keys to flat SSH key objects', () => {
      const aggregate = createMockDeploymentAggregate();
      const keys = DeploymentPresenter.extractSshKeys(aggregate);
      expect(keys).toHaveLength(1);
      expect(keys[0].key).toBe('ssh-rsa AAAA...');
      expect(keys[0].id).toBe('key-123');
      expect(keys[0].user).toEqual({ firstName: 'John', lastName: 'Doe' });
      expect(keys[0].user).not.toHaveProperty('email');
      expect(keys[0].user).not.toHaveProperty('members');
    });
  });
});
