import { describe, expect, it } from 'vitest';
import {
  deploymentComputeFields,
  deploymentDetailFields,
  deploymentNetworkingFields,
  deploymentSshKeyFields,
  deploymentStorageFields,
} from '../columns.js';
import type { DeploymentDetail } from '../deployments.js';

const deployment: DeploymentDetail = {
  id: 'deployment-1',
  name: 'test-deployment',
  status: 'provisioned',
  powerStatus: 'on',
  location: 'test-zone',
  isLocked: false,
  project: null,
  provisionedDate: '2026-07-28T00:00:00.000Z',
  rescueOs: null,
  specs: {
    os: null,
    gpu: { model: '', count: 0 },
    cpu: { model: '', count: 0, totalCores: 0, totalThreads: 0 },
    memory: { total: 0 },
    storage: { nvmeCount: 0, nvmeSize: 0, ssdCount: 0, ssdSize: 0, hddCount: 0, hddSize: 0, total: 0 },
  },
  networking: { ipv4: null, ipv6: null, mac: null, sshCommand: null },
  sshKeys: [],
  lifecycleActions: [],
  availableBaseLayers: [],
  availableComponentLayersByBase: {},
  defaultDiskLayouts: [],
};

describe('deploymentComputeFields', () => {
  it('steps memory from GB to TB at the base-2 boundary, not at 1000', () => {
    const gb = deploymentComputeFields({
      ...deployment,
      specs: { ...deployment.specs, memory: { total: 1023 } },
    });
    const tb = deploymentComputeFields({
      ...deployment,
      specs: { ...deployment.specs, memory: { total: 1024 } },
    });

    expect(gb).toContainEqual({ label: 'Memory', value: '1023 GB' });
    expect(tb).toContainEqual({ label: 'Memory', value: '1 TB' });
  });

  it('omits empty compute values', () => {
    expect(deploymentComputeFields(deployment)).toEqual([]);
  });
});

describe('deploymentDetailFields', () => {
  it('formats project, provision date, and rescue OS', () => {
    const fields = deploymentDetailFields({
      ...deployment,
      project: { id: 'project-1', name: 'Default', isDefault: true },
      rescueOs: 'Ubuntu Rescue',
    });

    expect(fields).toContainEqual({ label: 'Project', value: 'Default (default)' });
    expect(fields.find((field) => field.label === 'Provisioned')?.value).toBeTruthy();
    expect(fields).toContainEqual({ label: 'Rescue OS', value: 'Ubuntu Rescue' });
  });
});

describe('deploymentStorageFields', () => {
  it('formats populated storage and omits empty drive types', () => {
    const fields = deploymentStorageFields({
      ...deployment,
      specs: {
        ...deployment.specs,
        storage: {
          ...deployment.specs.storage,
          nvmeCount: 2,
          nvmeSize: 1_000_000_000_000,
          total: 2_000_000_000_000,
        },
      },
    });

    expect(fields).toEqual([
      { label: 'NVMe', value: '2x 931 GB NVMe' },
      { label: 'Total', value: '1.8 TB' },
    ]);
  });
});

describe('deploymentNetworkingFields', () => {
  it('returns only populated networking fields', () => {
    expect(
      deploymentNetworkingFields({
        ...deployment,
        networking: { ipv4: '192.0.2.1', ipv6: null, mac: null, sshCommand: 'ssh root@192.0.2.1' },
      }),
    ).toEqual([
      { label: 'IPv4', value: '192.0.2.1' },
      { label: 'SSH Command', value: 'ssh root@192.0.2.1' },
    ]);
  });
});

describe('deploymentSshKeyFields', () => {
  it('maps SSH keys to detail fields', () => {
    expect(
      deploymentSshKeyFields({
        ...deployment,
        sshKeys: [{ name: 'workstation', user: 'ubuntu' }],
      }),
    ).toEqual([{ label: 'workstation', value: 'ubuntu' }]);
  });
});
