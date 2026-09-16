import { z } from 'zod';
import { deploymentsRoutes } from '../../contract/deployments';
import { ProvisionServerRequestSchema } from '../baremetal';
import {
  DeploymentActionResponseSchema,
  ReprovisionDeploymentRequestSchema,
  ReprovisionDiskLayoutSchema,
  RescueModeActionResponseSchema,
} from '../deployments';
import { ProvisionRequestSchema as InventoryProvisionRequestSchema } from '../inventory';
import { provisionCommonFields, provisionDiskLayoutSchema } from '../provision';

const VALID_LAYOUT = {
  config: 'direct',
  format: 'ext4',
  mountpoint: '/',
  diskType: 'NVMe',
  disks: ['nvme0n1'],
  wipe: true,
};

const VALID_REQUEST = {
  deploymentName: 'my-deploy',
  operatingSystem: 'ubuntu-22.04',
  sshKeyIds: ['11111111-1111-4111-8111-111111111111'],
  diskLayouts: [VALID_LAYOUT],
};

const ProvisionFieldsSchema = z.object(provisionCommonFields);

describe('provision/reprovision disk-layout parity', () => {
  it('reprovision accepts a valid request', () => {
    expect(ReprovisionDeploymentRequestSchema.safeParse(VALID_REQUEST).success).toBe(true);
  });

  it('both paths reject an empty diskLayouts array', () => {
    const empty = { ...VALID_REQUEST, diskLayouts: [] };
    expect(ReprovisionDeploymentRequestSchema.safeParse(empty).success).toBe(false);
    expect(ProvisionFieldsSchema.safeParse(empty).success).toBe(false);
  });

  it('both layout schemas reject empty disk-name strings', () => {
    const badLayout = { ...VALID_LAYOUT, disks: [''] };
    expect(ReprovisionDiskLayoutSchema.safeParse(badLayout).success).toBe(false);
    expect(provisionDiskLayoutSchema.safeParse(badLayout).success).toBe(false);
  });

  describe('size field', () => {
    it('both layout schemas accept a positive integer size', () => {
      const withSize = { ...VALID_LAYOUT, size: 10 * 1024 ** 3 };
      expect(ReprovisionDiskLayoutSchema.safeParse(withSize).success).toBe(true);
      expect(provisionDiskLayoutSchema.safeParse(withSize).success).toBe(true);
    });

    it('both layout schemas accept an omitted size', () => {
      expect(ReprovisionDiskLayoutSchema.safeParse(VALID_LAYOUT).success).toBe(true);
      expect(provisionDiskLayoutSchema.safeParse(VALID_LAYOUT).success).toBe(true);
    });

    it('both layout schemas reject zero, negative, fractional, and non-numeric sizes', () => {
      for (const size of [0, -1, 1.5, '10']) {
        const bad = { ...VALID_LAYOUT, size };
        expect(ReprovisionDiskLayoutSchema.safeParse(bad).success).toBe(false);
        expect(provisionDiskLayoutSchema.safeParse(bad).success).toBe(false);
      }
    });
  });

  describe('mountpoint / format hardening (shell-injection boundary)', () => {
    const maliciousMountpoints = [
      `/data'; rm -rf / #`,
      '/data$(id)',
      '/data`whoami`',
      '/data && reboot',
      '/data|tee /etc/passwd',
      '/da ta',
    ];

    for (const mountpoint of maliciousMountpoints) {
      it(`both schemas reject mountpoint ${JSON.stringify(mountpoint)}`, () => {
        const bad = { ...VALID_LAYOUT, mountpoint };
        expect(ReprovisionDiskLayoutSchema.safeParse(bad).success).toBe(false);
        expect(provisionDiskLayoutSchema.safeParse(bad).success).toBe(false);
      });
    }

    it('both schemas accept a safe absolute mountpoint', () => {
      const ok = { ...VALID_LAYOUT, mountpoint: '/data_0/sub-dir.x' };
      expect(ReprovisionDiskLayoutSchema.safeParse(ok).success).toBe(true);
      expect(provisionDiskLayoutSchema.safeParse(ok).success).toBe(true);
    });

    it('both schemas reject mountpoints the server rejects (trailing slash, empty segment, >2 slashes)', () => {
      for (const mountpoint of ['/boot/', '//', '/mnt//data', '/a/b/c']) {
        const bad = { ...VALID_LAYOUT, mountpoint };
        expect(ReprovisionDiskLayoutSchema.safeParse(bad).success).toBe(false);
        expect(provisionDiskLayoutSchema.safeParse(bad).success).toBe(false);
      }
    });

    it('both schemas reject a format outside the ext4|xfs enum (no arbitrary fs token)', () => {
      for (const format of ['ext4; rm -rf /', 'btrfs`id`', 'zfs', '$(touch pwned)']) {
        const bad = { ...VALID_LAYOUT, format };
        expect(ReprovisionDiskLayoutSchema.safeParse(bad).success).toBe(false);
        expect(provisionDiskLayoutSchema.safeParse(bad).success).toBe(false);
      }
    });

    it('both schemas accept the supported formats ext4 and xfs', () => {
      for (const format of ['ext4', 'xfs']) {
        expect(ReprovisionDiskLayoutSchema.safeParse({ ...VALID_LAYOUT, format }).success).toBe(true);
        expect(provisionDiskLayoutSchema.safeParse({ ...VALID_LAYOUT, format }).success).toBe(true);
      }
    });
  });

  describe('customizations field parity (provision/reprovision/inventory)', () => {
    const schemas = {
      provision: ProvisionServerRequestSchema,
      reprovision: ReprovisionDeploymentRequestSchema,
      inventoryProvision: InventoryProvisionRequestSchema,
    };

    it('all three schemas accept a valid mixed record (single-select string + multi-select array + tee)', () => {
      const customizations = { gpuDriver: 'nvidia-driver-580', miscSoftware: ['docker', 'ollama'], tee: 'tee-setup' };
      for (const schema of Object.values(schemas)) {
        expect(schema.safeParse({ ...VALID_REQUEST, customizations }).success).toBe(true);
      }
    });

    it('all three schemas accept null and an omitted customizations field', () => {
      for (const schema of Object.values(schemas)) {
        expect(schema.safeParse({ ...VALID_REQUEST, customizations: null }).success).toBe(true);
        expect(schema.safeParse({ ...VALID_REQUEST }).success).toBe(true);
      }
    });

    it('all three schemas reject malformed customizations values', () => {
      const malformed = [{ gpuDriver: 123 }, { gpuDriver: { nested: 'x' } }, { miscSoftware: [1, 2] }];
      for (const schema of Object.values(schemas)) {
        for (const customizations of malformed) {
          expect(schema.safeParse({ ...VALID_REQUEST, customizations }).success).toBe(false);
        }
      }
    });
  });

  describe('tee field parity (provision/reprovision/inventory)', () => {
    const schemas = {
      provision: ProvisionServerRequestSchema,
      reprovision: ReprovisionDeploymentRequestSchema,
      inventoryProvision: InventoryProvisionRequestSchema,
    };

    it('all three schemas preserve tee: true (not silently stripped)', () => {
      for (const schema of Object.values(schemas)) {
        const result = schema.parse({ ...VALID_REQUEST, tee: true });
        expect(result.tee).toBe(true);
      }
    });

    it('all three schemas accept a request that omits tee', () => {
      for (const schema of Object.values(schemas)) {
        expect(schema.safeParse({ ...VALID_REQUEST }).success).toBe(true);
      }
    });

    it('all three schemas reject a non-boolean tee value', () => {
      for (const schema of Object.values(schemas)) {
        expect(schema.safeParse({ ...VALID_REQUEST, tee: 'yes' }).success).toBe(false);
      }
    });
  });
});

describe('deployment action response schemas', () => {
  it('rescue-mode endpoints use the rescue-specific response schema', () => {
    expect(deploymentsRoutes.activateRescueMode.responses[200]).toBe(RescueModeActionResponseSchema);
    expect(deploymentsRoutes.deactivateRescueMode.responses[200]).toBe(RescueModeActionResponseSchema);
  });

  it('lifecycle-job-producing endpoints keep the lifecycle-job response schema', () => {
    expect(deploymentsRoutes.reprovisionDeployment.responses[200]).toBe(DeploymentActionResponseSchema);
    expect(deploymentsRoutes.powerCycleDeployment.responses[200]).toBe(DeploymentActionResponseSchema);
    expect(deploymentsRoutes.powerControlDeployment.responses[200]).toBe(DeploymentActionResponseSchema);
    expect(deploymentsRoutes.deprovisionDeployment.responses[200]).toBe(DeploymentActionResponseSchema);
  });
});
