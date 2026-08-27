import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({ run: vi.fn() }));

import { operations } from '@repo/bridge-agent-protocol';
import { clearOperationsForTests, registerOperation, replaceOperationForTests } from '../../../dispatch/registry';
import { registerDeployOS } from '../deploy-os';

const ctx = {
  work_id: 'test',
  job_id: 'test',
  signal: new AbortController().signal,
  resultDelivered: Promise.resolve(),
  reportProgress: () => {},
  emit: () => {},
};

interface Call {
  op: string;
  input: unknown;
}

function installSubOpSpies(): { calls: Call[] } {
  const calls: Call[] = [];
  const opsToSpy: Array<[string, unknown]> = [
    ['deploy.restoreHttpsLayer', { bytes: 0 }],
    ['deploy.removeWhiteouts', { removed: 0 }],
    ['deploy.mountChroot', { mounted_points: [] }],
    ['deploy.unmountChroot', { unmounted: [] }],
    ['deploy.configureMdadm', { configured: false }],
    ['deploy.writeFstab', { success: true }],
    ['deploy.writeCrypttab', { success: true }],
    ['deploy.installLuksScripts', { installed: [] }],
    ['deploy.installGrub', { installed_targets: [] }],
    ['deploy.finalizeEfi', { skipped: false, cleaned: [] }],
    ['deploy.writeCloudInitFiles', { written: [] }],
    ['deploy.applyRoceChrootConfig', { success: true }],
    ['deploy.powerCycleCleanup', { success: true }],
  ];

  for (const [name, response] of opsToSpy) {
    registerOperation(
      name as never,
      (async (input: unknown) => {
        calls.push({ op: name, input });
        return response;
      }) as never,
    );
  }

  return { calls };
}

beforeEach(() => {
  clearOperationsForTests();
});

async function loadAndRegister(): Promise<{
  calls: Call[];
  run: (input: unknown) => Promise<unknown>;
}> {
  const { calls } = installSubOpSpies();
  registerDeployOS();
  const reg = await import('../../../dispatch/registry');
  const entry = reg.getHandler('deploy.deployOS');
  if (!entry) throw new Error('deployOS not registered');
  return { calls, run: (i) => entry.handler(i, ctx as never) as Promise<unknown> };
}

const BASE_SHA = 'a'.repeat(64);
const NVIDIA_SHA = 'b'.repeat(64);
const CUDA_SHA = 'c'.repeat(64);
const PODMAN_SHA = 'd'.repeat(64);

const baseInput = {
  target_path: '/target',
  arch: 'amd64' as const,
  uefi: true,
  distro: 'ubuntu',
  hostname: 'h1',
  grub_disks: [],
  image: {
    url: 'https://cache.test/sha256:' + BASE_SHA,
    compression: 'zstd' as const,
    sha256: BASE_SHA,
  },
  fstab: 'UUID=x / ext4 defaults 0 1\n',
  encrypted_volumes: [],
  rekey_volumes: [],
  grub: { defaults: '', fallback_cfg: 'fallback', purge_ttys: false },
  cloud_init: {
    cloud_cfg: '',
    meta_data: '',
    user_data: '',
    network_config: '',
    phone_home_script: '',
    phone_home_creds_json: '',
  },
  roce_iommu: false,
  cloud_init_vars: {
    device_id: '452',
    ssh_pubkeys: ['ssh-ed25519 AAA user@host'],
    netplan_yaml: 'network:\n  version: 2\n  ethernets:\n    eth0:\n      dhcp4: true\n',
    phone_home_creds: {
      deployment_os_token: 'brk_dev_os_test_token',
      endpoint: 'https://bridge.test/phone-home',
    },
  },
  grub_vars: {
    pci_realloc_off: false,
    purge_ttys: false,
  },
  luks_already_keyed: false,
  roce: { enabled: false, doca_repo_url: '' },
};

describe('deploy.deployOS — pipeline order', () => {
  it('runs base restore → whiteouts → chroot → config → cleanup, with no customizations / no LUKS / no RoCE', async () => {
    const { calls, run } = await loadAndRegister();
    const result = await run(baseInput);

    expect(result).toEqual({ deployed: true });

    expect(calls.map((c) => c.op)).toEqual([
      'deploy.restoreHttpsLayer',
      'deploy.removeWhiteouts',
      'deploy.mountChroot',
      'deploy.configureMdadm',
      'deploy.writeFstab',
      'deploy.installGrub',
      'deploy.finalizeEfi',
      'deploy.writeCloudInitFiles',
      'deploy.unmountChroot',
      'deploy.powerCycleCleanup',
    ]);
  });

  it('writes crypttab when non-empty and installs LUKS scripts when volumes + scripts present', async () => {
    const { calls, run } = await loadAndRegister();
    const newVol = { device: '/dev/md0', mapper: 'crypt-0', mountpoint: '/mnt/new', fs_type: 'xfs', label: 'NEW' };
    const preservedVol = {
      device: '/dev/md1',
      mapper: 'pcrypt-0',
      mountpoint: '/mnt/keep',
      fs_type: 'ext4',
      label: 'KEEP',
    };
    await run({
      ...baseInput,
      crypttab: 'data-vol UUID=yyy none luks\n',
      encrypted_volumes: [newVol, preservedVol],
      rekey_volumes: [newVol],
    });

    expect(calls.map((c) => c.op)).toContain('deploy.writeCrypttab');
    const luksCall = calls.find((c) => c.op === 'deploy.installLuksScripts');
    expect(luksCall).toBeDefined();
    const luksInput = luksCall!.input as { encrypted_volumes: unknown[]; rekey_volumes: unknown[] };
    expect(luksInput.encrypted_volumes).toEqual([newVol, preservedVol]);
    expect(luksInput.rekey_volumes).toEqual([newVol]);
  });

  it('skips LUKS installation when encrypted_volumes is empty even if luks_scripts is set', async () => {
    const { calls, run } = await loadAndRegister();
    await run({
      ...baseInput,
      luks_scripts: { rekey: 'r', unlock: 'u', lock: 'l' },
      encrypted_volumes: [],
    });
    expect(calls.map((c) => c.op)).not.toContain('deploy.installLuksScripts');
  });

  it('runs applyRoceChrootConfig when roce_iommu is true', async () => {
    const { calls, run } = await loadAndRegister();
    await run({ ...baseInput, roce_iommu: true });
    expect(calls.map((c) => c.op)).toContain('deploy.applyRoceChrootConfig');
  });

  it('always calls unmountChroot even when a mid-sequence sub-op throws', async () => {
    const { calls, run } = await loadAndRegister();

    replaceOperationForTests('deploy.installGrub', (async () => {
      throw new Error('grub boom');
    }) as never);

    await expect(run(baseInput)).rejects.toThrow(/grub boom/);

    expect(calls.map((c) => c.op)).toContain('deploy.unmountChroot');
    expect(calls.map((c) => c.op)).not.toContain('deploy.powerCycleCleanup');
  });
});

describe('deploy.deployOS — customization layers', () => {
  it('applies customizations in stack_position order, base first', async () => {
    const { calls, run } = await loadAndRegister();
    await run({
      ...baseInput,
      customizations: {
        layers: [
          {
            name: 'cuda',
            url: 'https://cache.test/sha256:' + CUDA_SHA,
            compression: 'zstd',
            stack_position: 30,
            sha256: CUDA_SHA,
          },
          {
            name: 'nvidia',
            url: 'https://cache.test/sha256:' + NVIDIA_SHA,
            compression: 'zstd',
            stack_position: 10,
            sha256: NVIDIA_SHA,
          },
          {
            name: 'podman',
            url: 'https://cache.test/sha256:' + PODMAN_SHA,
            compression: 'zstd',
            stack_position: 20,
            sha256: PODMAN_SHA,
          },
        ],
      },
    });

    const urls = calls
      .filter((c) => c.op === 'deploy.restoreHttpsLayer')
      .map((c) => operations['deploy.restoreHttpsLayer'].input.parse(c.input).url);
    expect(urls).toEqual([
      baseInput.image.url,
      'https://cache.test/sha256:' + NVIDIA_SHA,
      'https://cache.test/sha256:' + PODMAN_SHA,
      'https://cache.test/sha256:' + CUDA_SHA,
    ]);
  });

  it('returns { deployed: true } regardless of customization count', async () => {
    const { run } = await loadAndRegister();
    const result = (await run(baseInput)) as Record<string, unknown>;
    expect(result).toEqual({ deployed: true });
  });
});
