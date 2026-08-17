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
import type { OsPayload, PreparedStorage } from '../deploy-orchestration.service.js';
import {
  createDeployOrchestrationService,
  DeployOrchestrationError,
  DeployOrchestrationService,
  toCurtinArch,
} from '../deploy-orchestration.service.js';

const SHA_A = 'a'.repeat(64);
const ED25519_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKVkht1ZdckTEe2WZwwFgJX+cot8xSf5CAYaYqGtQKJ6';
const RSA_KEY =
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDqJ5yMyY7Z+5R1GsW4U5gM9kD7OyArUZT1CDE/rbyTUVUKxdAs5bb8b5SKYS1j8/18trVJvDPdvrkrL9NzHKRvjFNm/lgoB1ifZ1tUZ/S2zd1+Es4f9kSsJGNiV2i6EjB+gjNfCtkVs93k/wOijKbcCh7SQuPSbg+AlRIQJ+UUj9I8A1a5yOWvwuP4oK1f9hcdz3T4/Zgy2JgDkvdhms+dFBl27J02WUE7NXjBS6i0QrpWw2lEGvMylFo+f4CIMeUNKRec/d8D59Vv5Z/lUUIqKXOpECtoj93E6SD/mW7Rqp8LFfKZoi4YYGhpRmKHAY0pfAWnbDFsS7JKQ9w5/xh';
const RSA_BODY = RSA_KEY.slice('ssh-rsa '.length);

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
): DeployOrchestrationService {
  return new DeployOrchestrationService('job-1', {
    normalizeNetplanYaml: normalize ?? ((s) => (s.trim() ? s : null)),
    dispatch: (deviceId, operation, input, options) => {
      calls.push({ deviceId, operation, input, options });
      if (!(operation in responses)) {
        return Promise.reject(new Error(`unexpected operation ${operation}`));
      }
      const value = responses[operation];
      if (value instanceof Error) return Promise.reject(value);
      return Promise.resolve(value);
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
    pubkeys: [ED25519_KEY],
    user_data: null,
    boot_device: 'pxe',
    os_layers: [{ layer: 'base', sha256: SHA_A, compression: 'zstd', stack_position: 0 }],
    password_hash: null,
    server_token: {
      deployment_os_token: 'test-os-token-abc',
      endpoint: 'https://hub/api/v1/bmc/phone-home',
      exp: 1_730_000_000,
    },
    ...overrides,
  };
}

function storageDict(overrides: Partial<PreparedStorage> = {}): PreparedStorage {
  return {
    arch: 'amd64',
    uefi: true,
    efi_disks: ['/dev/sda'],
    grub_disks: ['/dev/sda'],
    fstab: 'UUID=x / ext4 defaults 0 1\n',
    crypttab: '',
    encrypted_volumes: [],
    preserved_encrypted_volumes: [],
    target_path: '/target',
    ...overrides,
  };
}

describe('resolveDeployTarget password/server_token propagation', () => {
  it('propagates lifecycle password_hash into os_payload', async () => {
    const service = makeService({}, []);
    const result = await service.resolveDeployTarget({
      deviceId: '42',
      platform: { os_distro: 'ubuntu', os_version: '22.04', codename: 'jammy', variant: 'vanilla' },
      lifecycleData: {
        hostname: 'srv-42',
        pubkeys: [ED25519_KEY],
        password_hash: '$6$rounds=656000$abc$xyz',
      },
    });
    expect(result.os_payload.password_hash).toBe('$6$rounds=656000$abc$xyz');
  });

  it('password_hash defaults to null when lifecycle omits it', async () => {
    const service = makeService({}, []);
    const result = await service.resolveDeployTarget({
      deviceId: '42',
      platform: {},
      lifecycleData: { hostname: 'srv-42', pubkeys: [] },
    });
    expect(result.os_payload.password_hash).toBeNull();
  });

  it('propagates lifecycle server_token into os_payload', async () => {
    const service = makeService({}, []);
    const token = {
      deployment_os_token: 'test-os-token-abc',
      endpoint: 'https://hub/api/v1/bmc/phone-home',
      exp: 1_730_000_000,
    };
    const result = await service.resolveDeployTarget({
      deviceId: '42',
      platform: {},
      lifecycleData: { hostname: 'srv-42', pubkeys: [], server_token: token },
    });
    expect(result.os_payload.server_token).toEqual(token);
  });

  it('server_token defaults to null when lifecycle omits it', async () => {
    const service = makeService({}, []);
    const result = await service.resolveDeployTarget({
      deviceId: '42',
      platform: {},
      lifecycleData: { hostname: 'srv-42', pubkeys: [] },
    });
    expect(result.os_payload.server_token).toBeNull();
  });
});

describe('deployOs password override', () => {
  it('omits password_hash from cloud_init_vars when osPayload has none', async () => {
    const calls: DispatchCall[] = [];
    const service = makeService({ 'deploy.deployOS': { deployed: true } }, calls);
    await service.deployOs({
      deviceId: 'dev-1',
      osPayload: osPayload(),
      storage: storageDict(),
      deviceNetplan: 'network: {}',
    });
    const cloudInit = (calls[0]?.input as Record<string, unknown>)['cloud_init_vars'] as Record<string, unknown>;
    expect('password_hash' in cloudInit).toBe(false);
  });

  it('passes payload password_hash through to cloud_init_vars verbatim', async () => {
    const calls: DispatchCall[] = [];
    const service = makeService({ 'deploy.deployOS': { deployed: true } }, calls);
    const hash = '$6$rounds=656000$abc$pretendValidSha512Crypt';
    await service.deployOs({
      deviceId: 'dev-1',
      osPayload: osPayload({ password_hash: hash }),
      storage: storageDict(),
      deviceNetplan: 'network: {}',
    });
    const cloudInit = (calls[0]?.input as Record<string, unknown>)['cloud_init_vars'] as Record<string, unknown>;
    expect(cloudInit['password_hash']).toBe(hash);
  });
});

describe('deployOs SSH public keys', () => {
  it('sends canonical public keys to cloud_init_vars', async () => {
    const calls: DispatchCall[] = [];
    const service = makeService({ 'deploy.deployOS': { deployed: true } }, calls);
    await service.deployOs({
      deviceId: 'dev-1',
      osPayload: osPayload({
        pubkeys: [
          `\n# ignored\nssh-rsa ${RSA_BODY.slice(0, 40)}\n${RSA_BODY.slice(40)} user@host`,
          `  ${ED25519_KEY} second@host \r\n`,
        ],
      }),
      storage: storageDict(),
      deviceNetplan: 'network: {}',
    });
    const payload = calls[0]?.input as Record<string, unknown>;
    const cloudInit = payload['cloud_init_vars'] as Record<string, unknown>;
    expect(cloudInit['ssh_pubkeys']).toEqual([`${RSA_KEY} user@host`, `${ED25519_KEY} second@host`]);
  });

  it('rejects supplied public keys that normalize to empty without a password hash', async () => {
    const calls: DispatchCall[] = [];
    const service = makeService({ 'deploy.deployOS': { deployed: true } }, calls);
    const rejection = service.deployOs({
      deviceId: 'dev-1',
      osPayload: osPayload({ pubkeys: ['\n', '# ignored\r\n'] }),
      storage: storageDict(),
      deviceNetplan: 'network: {}',
    });
    await expect(rejection).rejects.toThrowError(NonRetryableSagaError);
    await expect(rejection).rejects.toThrowError('All supplied SSH public keys are empty after normalization');
    expect(calls).toEqual([]);
  });

  it('permits an empty public key list when no keys were supplied', async () => {
    const calls: DispatchCall[] = [];
    const service = makeService({ 'deploy.deployOS': { deployed: true } }, calls);
    await service.deployOs({
      deviceId: 'dev-1',
      osPayload: osPayload({ pubkeys: [] }),
      storage: storageDict(),
      deviceNetplan: 'network: {}',
    });
    const payload = calls[0]?.input as Record<string, unknown>;
    const cloudInit = payload['cloud_init_vars'] as Record<string, unknown>;
    expect(cloudInit['ssh_pubkeys']).toEqual([]);
  });

  it('permits supplied public keys that normalize to empty when a password hash exists', async () => {
    const calls: DispatchCall[] = [];
    const service = makeService({ 'deploy.deployOS': { deployed: true } }, calls);
    await service.deployOs({
      deviceId: 'dev-1',
      osPayload: osPayload({
        pubkeys: ['# ignored\n'],
        password_hash: '$6$rounds=656000$abc$pretendValidSha512Crypt',
      }),
      storage: storageDict(),
      deviceNetplan: 'network: {}',
    });
    const payload = calls[0]?.input as Record<string, unknown>;
    const cloudInit = payload['cloud_init_vars'] as Record<string, unknown>;
    expect(cloudInit['ssh_pubkeys']).toEqual([]);
  });

  it('keeps deployment dispatch errors retryable', async () => {
    const service = makeService({ 'deploy.deployOS': new Error('agent timed out') }, []);
    const rejection = service.deployOs({
      deviceId: 'dev-1',
      osPayload: osPayload(),
      storage: storageDict(),
      deviceNetplan: 'network: {}',
    });
    await expect(rejection).rejects.toThrowError(DeployOrchestrationError);
    await expect(rejection).rejects.not.toBeInstanceOf(NonRetryableSagaError);
  });
});

describe('deployOs device payload fields', () => {
  async function runWith(overrides: Record<string, unknown>): Promise<Record<string, unknown>> {
    const calls: DispatchCall[] = [];
    const service = makeService({ 'deploy.deployOS': { deployed: true } }, calls);
    await service.deployOs({
      deviceId: 'dev-1',
      osPayload: osPayload(),
      storage: storageDict(),
      deviceNetplan: 'network: {}',
      ...overrides,
    });
    return calls[0]?.input as Record<string, unknown>;
  }

  it('gpu_model from payload reaches grub_vars', async () => {
    const payload = await runWith({ deviceGpuModel: 'NVIDIA H100' });
    expect((payload['grub_vars'] as Record<string, unknown>)['gpu_model']).toBe('NVIDIA H100');
  });

  it('gpu_model absent when payload omits it', async () => {
    const payload = await runWith({});
    const grub = payload['grub_vars'] as Record<string, unknown>;
    expect('gpu_model' in grub).toBe(false);
  });

  it('purge_ttys true flows into grub_vars', async () => {
    const payload = await runWith({ devicePurgeTtys: true });
    expect((payload['grub_vars'] as Record<string, unknown>)['purge_ttys']).toBe(true);
  });

  it('purge_ttys defaults to false', async () => {
    const payload = await runWith({});
    expect((payload['grub_vars'] as Record<string, unknown>)['purge_ttys']).toBe(false);
  });

  it('serial_port carries through to grub_vars.serial_ports', async () => {
    const payload = await runWith({ deviceSerialPort: 'ttyS1' });
    expect((payload['grub_vars'] as Record<string, unknown>)['serial_ports']).toEqual({ port: 'ttyS1' });
  });

  it('serial_ports omitted when payload has no serial_port', async () => {
    const payload = await runWith({});
    const grub = payload['grub_vars'] as Record<string, unknown>;
    expect('serial_ports' in grub).toBe(false);
  });

  it('deviceType slug drives pci_realloc_off=true', async () => {
    const payload = await runWith({ deviceType: 'poweredge-xe9780' });
    expect((payload['grub_vars'] as Record<string, unknown>)['pci_realloc_off']).toBe(true);
  });

  it('null deviceType keeps pci_realloc_off=false', async () => {
    const payload = await runWith({});
    expect((payload['grub_vars'] as Record<string, unknown>)['pci_realloc_off']).toBe(false);
  });

  it('network_type=roce flips roce_iommu and roce.enabled', async () => {
    const payload = await runWith({ deviceNetworkType: 'roce' });
    expect(payload['roce_iommu']).toBe(true);
    expect((payload['roce'] as Record<string, unknown>)['enabled']).toBe(true);
  });

  it('null network_type leaves roce flags off', async () => {
    const payload = await runWith({});
    expect(payload['roce_iommu']).toBe(false);
    expect((payload['roce'] as Record<string, unknown>)['enabled']).toBe(false);
  });

  it('infiniband network_type with node_desc injects the udev rule into cloud_init', async () => {
    const payload = await runWith({ deviceNetworkType: 'infiniband', nodeDesc: 'compute-42' });
    const cloudInit = payload['cloud_init_vars'] as Record<string, unknown>;
    const customUserData = cloudInit['custom_user_data_yaml'] as string;
    expect(customUserData).toContain('infiniband-node-desc');
  });
});

describe('deployOs dispatch shape', () => {
  it('emits the deploy.deployOS op with the required top-level keys', async () => {
    const calls: DispatchCall[] = [];
    const service = makeService({ 'deploy.deployOS': { deployed: true } }, calls);
    await service.deployOs({
      deviceId: 'dev-1',
      osPayload: osPayload(),
      storage: storageDict(),
      deviceNetplan: 'network: {}',
    });
    expect(calls[0]?.operation).toBe('deploy.deployOS');
    const payload = calls[0]?.input as Record<string, unknown>;
    for (const key of [
      'target_path',
      'arch',
      'uefi',
      'distro',
      'hostname',
      'grub_disks',
      'image',
      'fstab',
      'encrypted_volumes',
      'roce_iommu',
      'cloud_init_vars',
      'grub_vars',
      'luks_already_keyed',
      'roce',
    ]) {
      expect(payload, `missing key ${key}`).toHaveProperty(key);
    }
  });

  it('omits crypttab and customizations when not applicable', async () => {
    const calls: DispatchCall[] = [];
    const service = makeService({ 'deploy.deployOS': { deployed: true } }, calls);
    await service.deployOs({
      deviceId: 'dev-1',
      osPayload: osPayload(),
      storage: storageDict(),
      deviceNetplan: 'network: {}',
    });
    const payload = calls[0]?.input as Record<string, unknown>;
    expect('crypttab' in payload).toBe(false);
    expect('customizations' in payload).toBe(false);
  });
});

describe('toCurtinArch', () => {
  it('maps x86_64 to amd64', () => {
    expect(toCurtinArch('x86_64')).toBe('amd64');
  });

  it('maps aarch64 to arm64', () => {
    expect(toCurtinArch('aarch64')).toBe('arm64');
  });

  it('rejects an unknown architecture as non-retryable', () => {
    expect(() => toCurtinArch('riscv64')).toThrowError(NonRetryableSagaError);
    expect(() => toCurtinArch('riscv64')).toThrowError('unsupported architecture');
  });
});

describe('prepareStorage edges', () => {
  function diskGroups(): Record<string, unknown>[] {
    return [{ mountpoint: '/', format: 'ext4', config: 'single', disks: ['sda'] }];
  }

  function happyResponses(): Record<string, unknown> {
    return {
      'storage.detectExistingVolumeGroups': { volume_group_names: [] },
      'storage.detectExistingRaidArrays': { md_device_names: [] },
      'storage.resolveDisks': { layouts: [{ mountpoint: '/', size_bytes: 100_000_000_000, disks: ['/dev/sda'] }] },
      'storage.detectUefiMode': { uefi_mode: true },
      'storage.prepareStorage': {
        architecture: 'x86_64',
        uefi: true,
        fstab: 'UUID=x / ext4 defaults 0 1',
        crypttab: '',
        resolved_layouts: [],
        preserved_encrypted_volumes: [],
      },
    };
  }

  it('happy path returns the normalized storage dict', async () => {
    const service = makeService(happyResponses(), []);
    const result = await service.prepareStorage({ deviceId: '42', diskLayouts: diskGroups() });
    expect(result['arch']).toBe('amd64');
    expect(result['uefi']).toBe(true);
    expect(result['target_path']).toBe('/target');
  });

  it('overrides group disks when resolveDisks returns disks', async () => {
    const groups = [{ mountpoint: '/', format: 'ext4', config: 'raid1', disks: ['sda'] }];
    const responses = happyResponses();
    responses['storage.resolveDisks'] = {
      layouts: [{ mountpoint: '/', size_bytes: 500_000_000_000, disks: ['/dev/nvme0n1', '/dev/nvme1n1'] }],
    };
    const service = makeService(responses, []);
    await service.prepareStorage({ deviceId: '1', diskLayouts: groups });
    expect(groups[0]?.['disks']).toEqual(['/dev/nvme0n1', '/dev/nvme1n1']);
    expect(groups[0]?.['disk_size']).toBe(500_000_000_000);
  });

  it('preserves group disks when resolveDisks layout omits the disks key', async () => {
    const groups = [{ mountpoint: '/', format: 'ext4', config: 'single', disks: ['sda'] }];
    const responses = happyResponses();
    responses['storage.resolveDisks'] = { layouts: [{ mountpoint: '/', size_bytes: 200_000_000_000 }] };
    const service = makeService(responses, []);
    await service.prepareStorage({ deviceId: '1', diskLayouts: groups });
    expect(groups[0]?.['disks']).toEqual(['sda']);
    expect(groups[0]?.['disk_size']).toBe(200_000_000_000);
  });

  it('wraps a zero size_bytes as DeployOrchestrationError("did not return a size")', async () => {
    const responses = happyResponses();
    responses['storage.resolveDisks'] = { layouts: [{ mountpoint: '/', size_bytes: 0, disks: [] }] };
    const service = makeService(responses, []);
    await expect(service.prepareStorage({ deviceId: '1', diskLayouts: diskGroups() })).rejects.toThrowError(
      /did not return a size/,
    );
  });

  it('wraps a malformed resolveDisks payload as DeployOrchestrationError("malformed layouts")', async () => {
    const responses = happyResponses();
    responses['storage.resolveDisks'] = { layouts: [{ mountpoint: '/', size_bytes: 'not-an-int' }] };
    const service = makeService(responses, []);
    await expect(service.prepareStorage({ deviceId: '1', diskLayouts: diskGroups() })).rejects.toThrowError(
      /malformed layouts/,
    );
  });

  it('wraps non-dict resolveDisks layout entries as DeployOrchestrationError', async () => {
    const responses = happyResponses();
    responses['storage.resolveDisks'] = { layouts: ['not-a-dict'] };
    const service = makeService(responses, []);
    await expect(service.prepareStorage({ deviceId: '1', diskLayouts: diskGroups() })).rejects.toThrowError(
      DeployOrchestrationError,
    );
  });

  it('wraps a detectVolumeGroups failure as Storage preparation failed', async () => {
    const responses = happyResponses();
    responses['storage.detectExistingVolumeGroups'] = new Error('vg agent boom');
    const service = makeService(responses, []);
    await expect(service.prepareStorage({ deviceId: '1', diskLayouts: diskGroups() })).rejects.toThrowError(
      /Storage preparation failed/,
    );
  });

  it('wraps a prepareStorage agent failure as Storage preparation failed', async () => {
    const responses = happyResponses();
    responses['storage.prepareStorage'] = new Error('prepare agent boom');
    const service = makeService(responses, []);
    await expect(service.prepareStorage({ deviceId: '1', diskLayouts: diskGroups() })).rejects.toThrowError(
      /Storage preparation failed/,
    );
  });

  it('surfaces an unknown architecture as a non-retryable failure (no retry, no rewind)', async () => {
    const responses = happyResponses();
    responses['storage.prepareStorage'] = {
      architecture: 'riscv64',
      uefi: true,
      fstab: '',
      crypttab: '',
      resolved_layouts: [],
      preserved_encrypted_volumes: [],
    };
    const service = makeService(responses, []);
    const rejection = service.prepareStorage({ deviceId: '1', diskLayouts: diskGroups() });
    await expect(rejection).rejects.toThrowError(NonRetryableSagaError);
    await expect(rejection).rejects.not.toBeInstanceOf(DeployOrchestrationError);
    await expect(rejection).rejects.toThrowError(/unsupported architecture/);
  });

  it('propagates a target_path override into the returned storage dict', async () => {
    const service = makeService(happyResponses(), []);
    const result = await service.prepareStorage({
      deviceId: '1',
      diskLayouts: diskGroups(),
      targetPath: '/mnt/custom-target',
    });
    expect(result['target_path']).toBe('/mnt/custom-target');
  });
});

describe('createDeployOrchestrationService', () => {
  it('returns a DeployOrchestrationService bound to the supplied job id', async () => {
    const service = await createDeployOrchestrationService('job-xyz', {
      normalizeNetplanYaml: (s) => s,
    });
    expect(service).toBeInstanceOf(DeployOrchestrationService);
  });
});
