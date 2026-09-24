import { ContractType } from '@repo/utils';
import { describe, expect, it } from 'vitest';
import { ProvisionServerRequestSchema } from '../baremetal';
import { ContractTypeSchema, SelectableContractTypeSchema } from '../contract-type';
import { ProvisionRequestSchema } from '../inventory';

const VALID_REQUEST = {
  deploymentName: 'my-deploy',
  operatingSystem: 'ubuntu-22.04',
  sshKeyIds: ['11111111-1111-4111-8111-111111111111'],
  diskLayouts: [
    {
      config: 'direct',
      format: 'ext4',
      mountpoint: '/',
      diskType: 'NVMe',
      disks: ['nvme0n1'],
      wipe: true,
    },
  ],
};

describe('ContractTypeSchema / SelectableContractTypeSchema', () => {
  it('keeps the full enum on the read schema', () => {
    for (const value of Object.values(ContractType)) {
      expect(ContractTypeSchema.safeParse(value).success).toBe(true);
    }
  });

  it('accepts only RESERVED_ROLLING on the write schema', () => {
    expect(SelectableContractTypeSchema.safeParse(ContractType.RESERVED_ROLLING).success).toBe(true);
    expect(SelectableContractTypeSchema.safeParse(ContractType.ON_DEMAND).success).toBe(false);
    expect(SelectableContractTypeSchema.safeParse(ContractType.INTERRUPTIBLE).success).toBe(false);
    expect(SelectableContractTypeSchema.safeParse(ContractType.RESERVED).success).toBe(false);
  });

  it('rejects non-selectable types on provision write schemas', () => {
    expect(ProvisionServerRequestSchema.safeParse({ ...VALID_REQUEST, contractType: 'ON_DEMAND' }).success).toBe(
      false,
    );
    expect(ProvisionRequestSchema.safeParse({ ...VALID_REQUEST, contractType: 'INTERRUPTIBLE' }).success).toBe(false);
    expect(
      ProvisionServerRequestSchema.safeParse({ ...VALID_REQUEST, contractType: 'RESERVED_ROLLING' }).success,
    ).toBe(true);
  });
});
