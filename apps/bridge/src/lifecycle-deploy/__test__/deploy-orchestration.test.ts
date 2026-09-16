import { describe, expect, it, vi } from 'vitest';

vi.mock('../../sync/sync.config.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../sync/sync.config.js').catch(() => ({}));
  return {
    ...actual,
    getSyncConfig:
      (actual as { getSyncConfig?: () => unknown }).getSyncConfig ??
      (() => ({ osLayerUrl: 'https://layers.example/' })),
  };
});

import { NonRetryableSagaError } from '../../saga-framework/saga-runner.service.js';
import { getSyncConfig } from '../../sync/sync.config.js';
import type { OsPayload } from '../deploy-orchestration.service.js';
import { DeployOrchestrationError, DeployOrchestrationService } from '../deploy-orchestration.service.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

interface DispatchCall {
  deviceId: string;
  operation: string;
  input: unknown;
  options?: { jobId?: string; timeoutS?: number };
}

function makeService(
  responses: Record<string, unknown>,
  calls: DispatchCall[],
  normalize?: (s: string) => string | null,
) {
  return new DeployOrchestrationService('job-1', {
    normalizeNetplanYaml: normalize ?? ((s) => (s.trim() ? s : null)),
    dispatch: (deviceId, operation, input, options) => {
      calls.push({ deviceId, operation, input, options });
      if (!(operation in responses)) {
        return Promise.reject(new Error(`unexpected operation ${operation}`));
      }
      return Promise.resolve(responses[operation]);
    },
  });
}

function osPayload(overrides: Partial<OsPayload> = {}): OsPayload {
  return {
    device_id: 'dev-1',
    job_id: 'job-1',
    os_distro: 'ubuntu',
    os_version: '22.04',
    os_codename: 'jammy',
    os_variant: 'vanilla',
    disk_layouts: [],
    hostname: 'host-a',
    pubkeys: ['ssh-ed25519 AAAA key'],
    user_data: null,
    boot_device: 'pxe',
    os_layers: [
      { layer: 'gpu', sha256: SHA_B, compression: 'gzip', stack_position: 1 },
      { layer: 'base', sha256: SHA_A, compression: 'zstd', stack_position: 0 },
    ],
    password_hash: null,
    server_token: {
      deployment_os_token: 'test-os-token-fixture',
      endpoint: 'https://hub/api/v1/bmc/phone-home',
      exp: 1_730_000_000,
    },
    ...overrides,
  };
}

describe('resolveDeployTarget', () => {
  it('builds the os payload sorted by mountpoint length and threads server_token through', async () => {
    const service = makeService({}, []);
    const result = await service.resolveDeployTarget({
      deviceId: 'dev-1',
      platform: { os_distro: 'debian', os_version: '12', codename: 'bookworm', variant: 'minimal' },
      lifecycleData: {
        disk_layouts: [
          { mountpoint: '/data/long', disks: ['sdb'] },
          { mountpoint: '/', disks: ['sda'] },
        ],
        hostname: 'h',
        pubkeys: ['ssh-ed25519 AAAA k'],
        os_layers: [{ layer: 'base', sha256: SHA_A, compression: 'zstd', stack_position: 0 }],
        server_token: {
          deployment_os_token: 'test-os-token-abc',
          endpoint: 'https://hub/api/v1/bmc/phone-home',
          exp: 1,
        },
      },
    });

    const disks = result.disk_layouts;
    if (!Array.isArray(disks)) throw new Error('disk_layouts should be an array here');
    expect(disks.map((d) => (d as Record<string, unknown>)['mountpoint'])).toEqual(['/', '/data/long']);
    expect(result.os_payload.os_distro).toBe('debian');
    expect(result.os_payload.os_codename).toBe('bookworm');
    expect(result.os_payload.os_variant).toBe('minimal');
    expect(result.os_payload.boot_device).toBe('pxe');
    expect(result.os_payload.server_token).toEqual({
      deployment_os_token: 'test-os-token-abc',
      endpoint: 'https://hub/api/v1/bmc/phone-home',
      exp: 1,
    });
  });

  it('applies platform defaults', async () => {
    const service = makeService({}, []);
    const result = await service.resolveDeployTarget({ deviceId: 'dev-1', platform: {}, lifecycleData: {} });
    expect(result.os_payload.os_distro).toBe('ubuntu');
    expect(result.os_payload.os_version).toBe('22.04');
    expect(result.os_payload.os_codename).toBe('jammy');
    expect(result.os_payload.os_variant).toBe('vanilla');
    expect(result.os_payload.os_layers).toBeNull();
  });

  it('surfaces os_layers validation failures', async () => {
    const service = makeService({}, []);
    await expect(
      service.resolveDeployTarget({
        deviceId: 'dev-1',
        platform: {},
        lifecycleData: { os_layers: [{ layer: 'x', sha256: 'short', compression: 'zstd', stack_position: 0 }] },
      }),
    ).rejects.toThrowError("os_layers[0].sha256 must be 64 lowercase hex chars (got 'short')");
  });
});

describe('prepareStorage', () => {
  it('resolves device facts, renders curtin yaml, and normalizes the agent response', async () => {
    const calls: DispatchCall[] = [];
    const service = makeService(
      {
        'storage.detectExistingVolumeGroups': { volume_group_names: ['vg7'] },
        'storage.detectExistingRaidArrays': { md_device_names: [] },
        'storage.resolveDisks': { layouts: [{ mountpoint: '/', size_bytes: 480103981056, disks: ['sda'] }] },
        'storage.detectUefiMode': { uefi_mode: true },
        'storage.prepareStorage': {
          architecture: 'x86_64',
          uefi: true,
          fstab: 'UUID=1 / ext4 defaults 0 1',
          crypttab: '',
          resolved_layouts: [{ mountpoint: '/' }],
          preserved_encrypted_volumes: [],
        },
      },
      calls,
    );

    const diskLayouts: Record<string, unknown>[] = [
      { mountpoint: '/', disks: ['nvme0n1'], config: 'direct', format: 'ext4' },
    ];
    const storage = await service.prepareStorage({ deviceId: 'dev-1', diskLayouts });

    expect(storage['arch']).toBe('amd64');
    expect(storage['uefi']).toBe(true);
    expect(storage['target_path']).toBe('/target');
    expect(storage['efi_disks']).toEqual(['/dev/sda']);
    expect(diskLayouts[0]?.['disk_size']).toBe(480103981056);
    expect(diskLayouts[0]?.['disks']).toEqual(['sda']);

    const prepareCall = calls.find((c) => c.operation === 'storage.prepareStorage');
    expect(prepareCall?.options?.timeoutS).toBe(3600);
    const input = prepareCall?.input;
    expect(input).toMatchObject({ target_path: '/target' });
    const curtinYaml = (input as Record<string, unknown>)['curtin_yaml'];
    expect(typeof curtinYaml).toBe('string');
    expect(curtinYaml).toContain('version: 2');
  });

  it('wraps a missing resolved size in DeployOrchestrationError', async () => {
    const service = makeService(
      {
        'storage.detectExistingVolumeGroups': {},
        'storage.detectExistingRaidArrays': { md_device_names: [] },
        'storage.resolveDisks': { layouts: [] },
      },
      [],
    );
    await expect(
      service.prepareStorage({ deviceId: 'dev-1', diskLayouts: [{ mountpoint: '/', disks: ['sda'] }] }),
    ).rejects.toThrowError(DeployOrchestrationError);
  });
});

describe('deployOs', () => {
  function storage(): Record<string, unknown> {
    return {
      arch: 'amd64',
      uefi: true,
      efi_disks: ['/dev/sda'],
      grub_disks: [],
      fstab: 'UUID=2 /boot/efi vfat defaults 0 1\nUUID=3 /boot/efi2 vfat defaults 0 1',
      crypttab: '',
      disk_layouts: [],
      encrypted_volumes: [],
      preserved_encrypted_volumes: [
        { device: '/dev/md0', mapper: 'crypt-0', mountpoint: '/data', fs_type: 'ext4', label: 'data' },
      ],
      target_path: '/target',
    };
  }

  it('raises NonRetryableSagaError when netplan is missing', async () => {
    const service = makeService({}, []);
    await expect(
      service.deployOs({ deviceId: 'dev-1', osPayload: osPayload(), storage: storage() }),
    ).rejects.toThrowError(NonRetryableSagaError);
    await expect(
      service.deployOs({ deviceId: 'dev-1', osPayload: osPayload(), storage: storage() }),
    ).rejects.toThrowError('No netplan available for device dev-1');
  });

  it('raises NonRetryableSagaError when netplan normalization fails', async () => {
    const service = makeService({}, [], () => null);
    await expect(
      service.deployOs({ deviceId: 'dev-1', osPayload: osPayload(), storage: storage(), deviceNetplan: ' \n ' }),
    ).rejects.toThrowError('Payload netplan for device dev-1 is empty or invalid YAML');
  });

  it('fails the deploy non-retryably when os_layers is absent', async () => {
    const service = makeService({}, []);
    await expect(
      service.deployOs({
        deviceId: 'dev-1',
        osPayload: osPayload({ os_layers: null }),
        storage: storage(),
        deviceNetplan: 'network: {}',
      }),
    ).rejects.toThrowError(NonRetryableSagaError);
    await expect(
      service.deployOs({
        deviceId: 'dev-1',
        osPayload: osPayload({ os_layers: null }),
        storage: storage(),
        deviceNetplan: 'network: {}',
      }),
    ).rejects.toThrowError('os_payload.os_layers is required (HTTPS layers are the only deploy path)');
  });

  it('surfaces a malformed/absent server_token as NonRetryableSagaError (not a retryable rewrap)', async () => {
    const service = makeService({}, []);
    await expect(
      service.deployOs({
        deviceId: 'dev-1',
        osPayload: osPayload({ server_token: null }),
        storage: storage(),
        deviceNetplan: 'network: {}',
      }),
    ).rejects.toThrowError(NonRetryableSagaError);
    await expect(
      service.deployOs({
        deviceId: 'dev-1',
        osPayload: osPayload({ server_token: null }),
        storage: storage(),
        deviceNetplan: 'network: {}',
      }),
    ).rejects.toThrowError(
      'OS deployment failed: server_token missing from saga payload for device dev-1 (hub must mint it before enqueuing the provision saga)',
    );
  });

  it('propagates a NonRetryableSagaError thrown inside the try unchanged', async () => {
    const calls: DispatchCall[] = [];
    const service = new DeployOrchestrationService('job-1', {
      normalizeNetplanYaml: (s) => (s.trim() ? s : null),
      dispatch: (deviceId, operation, input, options) => {
        calls.push({ deviceId, operation, input, options });
        return Promise.reject(new NonRetryableSagaError('agent rejected payload: permanent'));
      },
    });
    const rejection = service.deployOs({
      deviceId: 'dev-1',
      osPayload: osPayload(),
      storage: storage(),
      deviceNetplan: 'network: {}',
    });
    await expect(rejection).rejects.toThrowError(NonRetryableSagaError);
    await expect(rejection).rejects.toThrowError('agent rejected payload: permanent');
    await expect(rejection).rejects.not.toBeInstanceOf(DeployOrchestrationError);
  });

  it('still wraps a genuinely unexpected (transient) error as a retryable DeployOrchestrationError', async () => {
    const calls: DispatchCall[] = [];
    const service = new DeployOrchestrationService('job-1', {
      normalizeNetplanYaml: (s) => (s.trim() ? s : null),
      dispatch: (deviceId, operation, input, options) => {
        calls.push({ deviceId, operation, input, options });
        return Promise.reject(new Error('agent timed out'));
      },
    });
    const rejection = service.deployOs({
      deviceId: 'dev-1',
      osPayload: osPayload(),
      storage: storage(),
      deviceNetplan: 'network: {}',
    });
    await expect(rejection).rejects.toThrowError(DeployOrchestrationError);
    await expect(rejection).rejects.not.toBeInstanceOf(NonRetryableSagaError);
    await expect(rejection).rejects.toThrowError('OS deployment failed: agent timed out');
  });

  it('assembles the deploy.deployOS proto payload', async () => {
    const calls: DispatchCall[] = [];
    const service = makeService({ 'deploy.deployOS': { deployed: true, elapsed_s: 12 } }, calls);

    const result = await service.deployOs({
      deviceId: 'dev-1',
      osPayload: osPayload(),
      storage: storage(),
      deviceNetplan: 'network:\n  version: 2\n',
      deviceGpuModel: 'h100',
      devicePurgeTtys: true,
      deviceSerialPort: 'ttyS1',
      deviceSerialBaud: 115200,
      deviceType: 'poweredge-xe9780',
      deviceNetworkType: 'infiniband',
      nodeDesc: 'gpu-7',
    });

    expect(result).toEqual({ deployed: true, elapsed_s: 12 });
    const call = calls[0];
    expect(call?.operation).toBe('deploy.deployOS');
    expect(call?.options?.timeoutS).toBe(1800);

    const payload = call?.input;
    const base = getSyncConfig().osLayerUrl.replace(/\/+$/, '');
    expect(payload).toMatchObject({
      target_path: '/target',
      arch: 'amd64',
      uefi: true,
      distro: 'ubuntu',
      hostname: 'host-a',
      grub_disks: [],
      image: { url: `${base}/sha256:${SHA_A}`, compression: 'zstd', sha256: SHA_A },
      customizations: {
        layers: [
          { name: 'gpu', url: `${base}/sha256:${SHA_B}`, compression: 'gzip', stack_position: 1, sha256: SHA_B },
        ],
      },
      roce_iommu: false,
      luks_already_keyed: true,
      roce: { enabled: false, doca_repo_url: '' },
      grub_vars: {
        pci_realloc_off: true,
        purge_ttys: true,
        gpu_model: 'h100',
        serial_ports: { port: 'ttyS1', baud: 115200 },
      },
    });

    const record = payload as Record<string, unknown>;
    expect(record['fstab']).toBe('UUID=2 /boot/efi vfat defaults 0 1\n# UUID=3 /boot/efi vfat defaults 0 1\n\n');
    expect(record['crypttab']).toBeUndefined();
    expect(record['encrypted_volumes']).toEqual([
      { device: '/dev/md0', mapper: 'crypt-0', mountpoint: '/data', fs_type: 'ext4', label: 'data' },
    ]);
    expect(record['rekey_volumes']).toEqual([]);

    const cloudInit = record['cloud_init_vars'] as Record<string, unknown>;
    expect(cloudInit['device_id']).toBe('dev-1');
    expect(cloudInit['netplan_yaml']).toBe('network:\n  version: 2\n');
    expect(cloudInit['phone_home_creds']).toEqual({
      deployment_os_token: 'test-os-token-fixture',
      endpoint: 'https://hub/api/v1/bmc/phone-home',
    });
    expect('custom_user_data_yaml' in cloudInit).toBe(false);
    expect(record['infiniband']).toEqual({ enabled: true, node_desc: 'gpu-7' });
  });

  it('mixed new+preserved encryption: rekey targets ONLY new volumes (data-loss guard)', async () => {
    const calls: DispatchCall[] = [];
    const service = makeService({ 'deploy.deployOS': { deployed: true } }, calls);

    const newVol = { device: '/dev/md0', mapper: 'crypt-0', mountpoint: '/new', fs_type: 'xfs', label: 'new' };
    const preservedVol = {
      device: '/dev/md1',
      mapper: 'pcrypt-0',
      mountpoint: '/keep',
      fs_type: 'ext4',
      label: 'keep',
    };

    await service.deployOs({
      deviceId: 'dev-1',
      osPayload: osPayload(),
      storage: { ...storage(), encrypted_volumes: [newVol], preserved_encrypted_volumes: [preservedVol] },
      deviceNetplan: 'network: {}',
    });

    const payload = calls[0]?.input as Record<string, unknown>;
    expect(payload['encrypted_volumes']).toEqual([preservedVol, newVol]);
    const encVols = payload['encrypted_volumes'] as Array<{ device: string }>;
    const preservedIdx = encVols.findIndex((v) => v.device === preservedVol.device);
    const newIdx = encVols.findIndex((v) => v.device === newVol.device);
    expect(preservedIdx).toBeLessThan(newIdx);
    expect(payload['rekey_volumes']).toEqual([newVol]);
    expect(payload['luks_already_keyed']).toBe(false);
  });

  it('enables roce vars only when the east-west network is roce', async () => {
    const calls: DispatchCall[] = [];
    const service = makeService({ 'deploy.deployOS': { deployed: true } }, calls);

    await service.deployOs({
      deviceId: 'dev-1',
      osPayload: osPayload(),
      storage: storage(),
      deviceNetplan: 'network: {}',
      deviceNetworkType: 'roce',
    });

    const payload = calls[0]?.input as Record<string, unknown>;
    expect(payload['roce_iommu']).toBe(true);
    expect(payload['roce']).toEqual({
      enabled: true,
      doca_repo_url: 'https://linux.mellanox.com/public/repo/doca/3.3.0/ubuntu22.04/x86_64/',
    });
  });
});
