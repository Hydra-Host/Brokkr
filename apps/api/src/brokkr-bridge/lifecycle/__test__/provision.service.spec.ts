import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DeviceTokenRevocationReason, TeeCapability } from '@repo/database';
import * as layersModule from '@repo/layers';
import { ConfigAtomWriter, TTL_IPXE_URL_SECONDS, ipxeUrl } from 'src/common/redis';
import { DeviceTokensService } from 'src/device-tokens/device-tokens.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { Mock, vi } from 'vitest';
import { DeviceContextService } from '../../device-context.service';
import { NetplanPublisherService } from '../../netplan/netplan-publisher.service';
import { BridgeQueueService } from '../../queue/bridge-queue.service';
import { ServerTokenService } from '../../server-token/server-token.service';
import { OsLayersResolverService } from '../os-layers-resolver.service';
import { BridgeProvisionService } from '../provision.service';

const DEVICE_UUID = '550e8400-e29b-41d4-a716-446655440042';
const JOB_ID = 'job-abc-123';
const OS_SLUG = 'ubuntu-noble-hpc';
const ZONE_ID = '1-1-1';
const TENANT_ID = 100;
const LAYER_BUILD_ID = 'test-layer-build-id';
const DEPLOY_NETPLAN_YAML = 'network:\n  version: 2\n  ethernets:\n    eth0:\n      dhcp4: true\n';
const GPU_MODEL = 'NVIDIA H100 80GB HBM3';
const DEVICE_MODEL_SLUG = 'gigabyte-g593-sd1';
const OPTIMAL_SERIAL_PORT = 'ttyS1';
const NETWORK_TYPE = 'roce';

interface ProvisionDeviceFactsRow {
  gpus: { model: string }[];
  server: { purgeTtys: boolean | null } | null;
  deviceModel: { slug: string | null } | null;
  solConfig: { optimalPort: string | null } | null;
}

function makeProvisionFactsRow(overrides: Partial<ProvisionDeviceFactsRow> = {}): ProvisionDeviceFactsRow {
  return {
    gpus: [{ model: GPU_MODEL }],
    server: { purgeTtys: true },
    deviceModel: { slug: DEVICE_MODEL_SLUG },
    solConfig: { optimalPort: OPTIMAL_SERIAL_PORT },
    ...overrides,
  };
}

const LIFECYCLE_DATA = {
  hostname: 'test-host',
  diskLayouts: [{ type: 'raid1' }],
  pubkeys: ['ssh-rsa AAAA...'],
  userData: null,
  ipxeUrl: null,
  passwordHash: null,
  customizations: null,
};

function makeDevice(
  overrides: {
    architecture?: 'x86_64' | 'aarch64' | null;
    teeCapable?: TeeCapability;
    netplanOverride?: string | null;
  } = {},
) {
  return {
    id: DEVICE_UUID,
    zoneId: ZONE_ID,
    ipmiIpAddress: '10.0.0.1/24',
    ipmiBootDeviceOverride: null,
    primaryIp4: null,
    netplanOverride: null,
    cpus: [{ architecture: 'architecture' in overrides ? overrides.architecture : 'x86_64' }],
    supplier: { id: 'supplier-1' },
    server: {
      teeEnabled: false,
      teeCapable: overrides.teeCapable ?? TeeCapability.UNVERIFIED,
      netplanOverride: overrides.netplanOverride ?? null,
    },
  };
}

describe('BridgeProvisionService', () => {
  let service: BridgeProvisionService;
  let mockResolveDeviceContext: Mock;
  let mockDeviceFindUnique: Mock;
  let mockZoneFindUnique: Mock;
  let mockEnqueueSagaJob: Mock;
  let mockPublishForProvisioning: Mock;
  let mockRenderDeployNetplan: Mock;
  let mockResolveOsLayers: Mock;
  let mockMintForCtx: Mock;
  let mockWriteAtomBestEffort: Mock;
  let mockSetString: Mock;
  let mockIssueDeploymentOsToken: Mock;
  let mockRevokeToken: Mock;
  let mockRevokeBrokkrLiveTokensForDevice: Mock;
  let mockTransaction: Mock;
  let mockDeploymentLayerDeleteMany: Mock;
  let mockDeploymentLayerCreateMany: Mock;
  let mockLogger: { log: Mock; warn: Mock; error: Mock; debug: Mock; verbose: Mock; setContext: Mock };

  beforeEach(async () => {
    vi.stubEnv('LOCAL_SIMULATION_ENABLED', '');
    vi.spyOn(layersModule.LayerRecord, 'findBaseOsSampleBySlug').mockResolvedValue({
      osDistro: 'ubuntu',
      osCodename: 'noble',
      osVersion: '24.04',
    });
    mockResolveDeviceContext = vi.fn().mockResolvedValue({
      device: makeDevice(),
      zoneId: ZONE_ID,
      bmcIp: '10.0.0.1',
      credentials: { bmc_user: 'admin', bmc_pass: 'secret' },
    });
    mockDeviceFindUnique = vi.fn().mockResolvedValue(makeProvisionFactsRow());
    mockZoneFindUnique = vi
      .fn()
      .mockResolvedValue({ id: ZONE_ID, layerBuildId: LAYER_BUILD_ID, eastWestNetworkType: 'ROCE' });
    vi.spyOn(layersModule, 'resolveEffectiveBuild').mockResolvedValue(LAYER_BUILD_ID);
    mockEnqueueSagaJob = vi.fn().mockResolvedValue({ id: 'bullmq-job-1' });
    mockPublishForProvisioning = vi.fn().mockResolvedValue({ deployNetplan: DEPLOY_NETPLAN_YAML, isVpc: true });
    mockRenderDeployNetplan = vi.fn().mockResolvedValue(DEPLOY_NETPLAN_YAML);
    mockResolveOsLayers = vi.fn().mockResolvedValue({
      entries: [{ layer: 'ubuntu-24.04-hpc', sha256: 'a'.repeat(64), compression: 'zstd', stack_position: 0 }],
      resolved: [],
    });
    mockMintForCtx = vi.fn().mockResolvedValue({
      brokkr_live_token: 'test-live-token',
      endpoint: 'https://brokkr.example/api/v1/bmc/phone-home',
      exp: 1_900_000_000,
    });
    mockWriteAtomBestEffort = vi.fn().mockResolvedValue(undefined);
    mockSetString = vi.fn().mockResolvedValue(undefined);
    mockIssueDeploymentOsToken = vi.fn().mockResolvedValue({
      tokenId: 'deployment-token-id',
      displayId: 'dtok_deploy',
      plaintext: 'test-os-token',
      material: {
        deployment_os_token: 'test-os-token',
        endpoint: 'https://brokkr.example/api/v1/bmc/phone-home',
      },
      reused: false,
    });
    mockRevokeToken = vi.fn().mockResolvedValue(undefined);
    mockRevokeBrokkrLiveTokensForDevice = vi.fn().mockResolvedValue(undefined);
    mockTransaction = vi.fn().mockResolvedValue([]);
    mockDeploymentLayerDeleteMany = vi.fn();
    mockDeploymentLayerCreateMany = vi.fn();
    mockLogger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      verbose: vi.fn(),
      setContext: vi.fn().mockReturnThis(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BridgeProvisionService,
        {
          provide: BridgeQueueService,
          useValue: { enqueueSagaJob: mockEnqueueSagaJob },
        },
        {
          provide: DeviceContextService,
          useValue: { resolve: mockResolveDeviceContext },
        },
        {
          provide: PrismaClient,
          useValue: {
            device: { findUnique: mockDeviceFindUnique },
            zone: { findUnique: mockZoneFindUnique },
            $transaction: mockTransaction,
            deploymentLayer: {
              deleteMany: mockDeploymentLayerDeleteMany,
              createMany: mockDeploymentLayerCreateMany,
            },
          },
        },
        {
          provide: NetplanPublisherService,
          useValue: {
            publishForProvisioning: mockPublishForProvisioning,
            renderDeployNetplan: mockRenderDeployNetplan,
          },
        },
        {
          provide: OsLayersResolverService,
          useValue: { resolve: mockResolveOsLayers },
        },
        {
          provide: ServerTokenService,
          useValue: {
            mintForCtx: mockMintForCtx,
            writeAtomBestEffort: mockWriteAtomBestEffort,
          },
        },
        {
          provide: ConfigAtomWriter,
          useValue: { setString: mockSetString },
        },
        {
          provide: DeviceTokensService,
          useValue: {
            issueDeploymentOsToken: mockIssueDeploymentOsToken,
            revokeToken: mockRevokeToken,
            revokeBrokkrLiveTokensForDevice: mockRevokeBrokkrLiveTokensForDevice,
          },
        },
        {
          provide: `LoggerService${BridgeProvisionService.name}`,
          useValue: mockLogger,
        },
      ],
    }).compile();

    service = module.get<BridgeProvisionService>(BridgeProvisionService);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('calls netplanPublisher.publishForProvisioning before enqueueSagaJob', async () => {
    const callOrder: string[] = [];
    mockPublishForProvisioning.mockImplementation(async () => {
      callOrder.push('publishForProvisioning');
      return { deployNetplan: DEPLOY_NETPLAN_YAML, isVpc: true };
    });
    mockEnqueueSagaJob.mockImplementation(async () => {
      callOrder.push('enqueueSagaJob');
      return { id: 'bullmq-job-1' };
    });

    await service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG);

    expect(mockPublishForProvisioning).toHaveBeenCalledOnce();
    expect(mockPublishForProvisioning).toHaveBeenCalledWith({
      deviceId: DEVICE_UUID,
      zonePrefix: ZONE_ID,
      jobId: JOB_ID,
    });
    expect(mockEnqueueSagaJob).toHaveBeenCalledOnce();
    expect(callOrder).toEqual(['publishForProvisioning', 'enqueueSagaJob']);
  });

  // Keys on the override, not the sim flag: under `rendered_netplan` the sim stops seeding an
  // override, and the publish must then run for real.
  it('skips the netplan publish for a sim device that carries a seeded override', async () => {
    vi.stubEnv('LOCAL_SIMULATION_ENABLED', 'true');
    vi.stubEnv('HH_ENV', 'dev'); // isLocalSimulationEnabled gates on this too
    mockResolveDeviceContext.mockResolvedValue({
      device: makeDevice({ netplanOverride: 'network: {version: 2}' }),
      zoneId: ZONE_ID,
      bmcIp: '10.0.0.1',
      credentials: { bmc_user: 'admin', bmc_pass: 'secret' },
    });

    await service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG);

    expect(mockPublishForProvisioning).not.toHaveBeenCalled();
    expect(mockEnqueueSagaJob).toHaveBeenCalledOnce();
  });

  it('publishes netplan for a sim device with no override (rendered_netplan mode)', async () => {
    vi.stubEnv('LOCAL_SIMULATION_ENABLED', 'true');
    vi.stubEnv('HH_ENV', 'dev'); // isLocalSimulationEnabled gates on this too
    mockResolveDeviceContext.mockResolvedValue({
      device: makeDevice({ netplanOverride: null }),
      zoneId: ZONE_ID,
      bmcIp: '10.0.0.1',
      credentials: { bmc_user: 'admin', bmc_pass: 'secret' },
    });

    await service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG);

    expect(mockPublishForProvisioning).toHaveBeenCalledOnce();
    expect(mockPublishForProvisioning).toHaveBeenCalledWith({
      deviceId: DEVICE_UUID,
      zonePrefix: ZONE_ID,
      jobId: JOB_ID,
    });
  });

  it('aborts provisioning when publishForProvisioning rejects', async () => {
    mockPublishForProvisioning.mockRejectedValueOnce(new Error('redis exploded'));

    await expect(service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG)).rejects.toThrow(
      'redis exploded',
    );

    expect(mockEnqueueSagaJob).not.toHaveBeenCalled();
  });

  it('revokes internally minted deployment OS tokens when enqueueSagaJob rejects', async () => {
    mockEnqueueSagaJob.mockRejectedValueOnce(new Error('queue down'));

    await expect(service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG)).rejects.toThrow(
      'queue down',
    );

    expect(mockRevokeToken).toHaveBeenCalledWith({
      tokenId: 'deployment-token-id',
      reason: DeviceTokenRevocationReason.REPROVISION,
      note: expect.stringContaining('queue down'),
      actor: 'system',
    });
  });

  it('revokes pre-issued deployment OS tokens when enqueueSagaJob rejects', async () => {
    mockEnqueueSagaJob.mockRejectedValueOnce(new Error('queue down'));

    await expect(
      service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG, null, {
        tokenId: 'preissued-token-id',
        displayId: 'dtok_preissued',
        plaintext: 'test-os-token-preissued',
        material: {
          deployment_os_token: 'test-os-token-preissued',
          endpoint: 'https://brokkr.example/api/v1/bmc/phone-home',
        },
        reused: false,
      }),
    ).rejects.toThrow('queue down');

    expect(mockIssueDeploymentOsToken).not.toHaveBeenCalled();
    expect(mockRevokeToken).toHaveBeenCalledWith({
      tokenId: 'preissued-token-id',
      reason: DeviceTokenRevocationReason.REPROVISION,
      note: expect.stringContaining('queue down'),
      actor: 'system',
    });
  });

  it('revokes Brokkr Live tokens when custom-iPXE enqueueSagaJob rejects after mint', async () => {
    mockEnqueueSagaJob.mockRejectedValueOnce(new Error('queue down'));

    await expect(
      service.provisionDevice(
        DEVICE_UUID,
        JOB_ID,
        'provisioning',
        { ...LIFECYCLE_DATA, ipxeUrl: 'https://boot.example/custom.ipxe' },
        OS_SLUG,
      ),
    ).rejects.toThrow('queue down');

    expect(mockMintForCtx).toHaveBeenCalledOnce();
    expect(mockWriteAtomBestEffort).toHaveBeenCalledOnce();
    expect(mockRevokeToken).toHaveBeenCalledWith({
      tokenId: 'deployment-token-id',
      reason: DeviceTokenRevocationReason.REPROVISION,
      note: expect.stringContaining('queue down'),
      actor: 'system',
    });
    expect(mockRevokeBrokkrLiveTokensForDevice).toHaveBeenCalledWith(
      DEVICE_UUID,
      DeviceTokenRevocationReason.REPROVISION,
      expect.stringContaining('queue down'),
    );
  });

  it('does not revoke tokens when a post-enqueue action throws', async () => {
    mockLogger.log.mockImplementation((message: string) => {
      if (message.includes('saga enqueued:')) {
        throw new Error('logger down');
      }
    });

    await expect(
      service.provisionDevice(
        DEVICE_UUID,
        JOB_ID,
        'provisioning',
        { ...LIFECYCLE_DATA, ipxeUrl: 'https://boot.example/custom.ipxe' },
        OS_SLUG,
      ),
    ).rejects.toThrow('logger down');

    expect(mockEnqueueSagaJob).toHaveBeenCalledOnce();
    expect(mockRevokeToken).not.toHaveBeenCalled();
    expect(mockRevokeBrokkrLiveTokensForDevice).not.toHaveBeenCalled();
  });

  it('rejects a TEE request on a non-TEE-capable device before mutating any state', async () => {
    await expect(
      service.provisionDevice(
        DEVICE_UUID,
        JOB_ID,
        'reprovisioning',
        { ...LIFECYCLE_DATA, tee: true },
        OS_SLUG,
        'deployment-xyz',
      ),
    ).rejects.toThrow(/not TEE-capable/);

    expect(mockPublishForProvisioning).not.toHaveBeenCalled();
    expect(mockResolveOsLayers).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockDeploymentLayerDeleteMany).not.toHaveBeenCalled();
    expect(mockIssueDeploymentOsToken).not.toHaveBeenCalled();
  });

  it('rejects ipxe-custom-tee OS slug on a non-TEE-capable device', async () => {
    await expect(
      service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, 'ipxe-custom-tee'),
    ).rejects.toThrow(/not TEE-capable/);

    expect(mockResolveOsLayers).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockIssueDeploymentOsToken).not.toHaveBeenCalled();
  });

  it('rejects tee-setup customization on a non-TEE-capable device', async () => {
    await expect(
      service.provisionDevice(
        DEVICE_UUID,
        JOB_ID,
        'provisioning',
        { ...LIFECYCLE_DATA, customizations: [layersModule.LAYER_SLUGS.tee.TEE_SETUP] },
        OS_SLUG,
      ),
    ).rejects.toThrow(/not TEE-capable/);

    expect(mockResolveOsLayers).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockIssueDeploymentOsToken).not.toHaveBeenCalled();
  });

  it('enqueues the saga with correct payload after successful publish', async () => {
    await service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG);

    expect(mockEnqueueSagaJob).toHaveBeenCalledWith(
      ZONE_ID,
      'provision',
      JOB_ID,
      expect.objectContaining({
        device_id: DEVICE_UUID,
        status: 'provisioning',
        tee_enabled: false,
        tee_requested: false,
        lifecycle_data: expect.objectContaining({
          server_token: {
            deployment_os_token: 'test-os-token',
            endpoint: 'https://brokkr.example/api/v1/bmc/phone-home',
          },
        }),
        platform: {
          slug: OS_SLUG,
          codename: 'noble',
          os_version: '24.04',
          os_distro: 'ubuntu',
          variant: 'hpc',
        },
      }),
      DEVICE_UUID,
      { removeOnComplete: { count: 0 } },
    );
  });

  it('sets tee_requested=true in saga payload when tee is requested on a capable device', async () => {
    mockResolveDeviceContext.mockResolvedValueOnce({
      device: makeDevice({ teeCapable: TeeCapability.TRUE }),
      zoneId: ZONE_ID,
      tenantId: TENANT_ID,
      bmcIp: '10.0.0.1',
      credentials: { bmc_user: 'admin', bmc_pass: 'secret' },
    });

    await service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', { ...LIFECYCLE_DATA, tee: true }, OS_SLUG);

    expect(mockEnqueueSagaJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ tee_requested: true, tee_enabled: false }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('does not ship the tenancy triplet in the saga payload (spoke self-sources zone_id)', async () => {
    await service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG);

    const payload = mockEnqueueSagaJob.mock.calls[0][3];
    expect(payload).not.toHaveProperty('tenant_id');
    expect(payload).not.toHaveProperty('site_id');
    expect(payload).not.toHaveProperty('location_id');
  });

  it('resolves os_layers and includes them in the saga payload when ipxeUrl is null', async () => {
    const entries = [
      { layer: 'ubuntu-24.04-hpc', sha256: 'a'.repeat(64), compression: 'zstd', stack_position: 0 },
      { layer: 'nvidia-driver-580', sha256: 'b'.repeat(64), compression: 'zstd', stack_position: 1 },
    ];
    mockResolveOsLayers.mockResolvedValueOnce({
      entries,
      resolved: [
        { layerId: 'layer-base', layerArtifactId: 'art-base' },
        { layerId: 'layer-driver', layerArtifactId: 'art-driver' },
      ],
    });

    await service.provisionDevice(
      DEVICE_UUID,
      JOB_ID,
      'provisioning',
      { ...LIFECYCLE_DATA, customizations: ['nvidia-driver-580'] },
      OS_SLUG,
    );

    expect(mockResolveOsLayers).toHaveBeenCalledWith(
      {
        layerBuildId: LAYER_BUILD_ID,
        operatingSystemSlug: OS_SLUG,
        customizationSlugs: ['nvidia-driver-580'],
        arch: 'amd64',
      },
      JOB_ID,
    );

    expect(mockEnqueueSagaJob).toHaveBeenCalledWith(
      ZONE_ID,
      'provision',
      JOB_ID,
      expect.objectContaining({
        lifecycle_data: expect.objectContaining({
          os_layers: entries,
          ipxe_url: null,
        }),
      }),
      DEVICE_UUID,
      { removeOnComplete: { count: 0 } },
    );
  });

  it('skips the resolver and sets os_layers null when ipxeUrl is provided (custom-iPXE escape hatch)', async () => {
    await service.provisionDevice(
      DEVICE_UUID,
      JOB_ID,
      'provisioning',
      { ...LIFECYCLE_DATA, ipxeUrl: 'https://customer.example/boot.ipxe' },
      OS_SLUG,
    );

    expect(mockResolveOsLayers).not.toHaveBeenCalled();

    expect(mockEnqueueSagaJob).toHaveBeenCalledWith(
      ZONE_ID,
      'provision',
      JOB_ID,
      expect.objectContaining({
        lifecycle_data: expect.objectContaining({
          os_layers: null,
          ipxe_url: 'https://customer.example/boot.ipxe',
        }),
      }),
      DEVICE_UUID,
      { removeOnComplete: { count: 0 } },
    );
  });

  it('writes the custom-iPXE url to the short-lived redis key when ipxeUrl is set', async () => {
    await service.provisionDevice(
      DEVICE_UUID,
      JOB_ID,
      'provisioning',
      { ...LIFECYCLE_DATA, ipxeUrl: 'https://customer.example/boot.ipxe' },
      OS_SLUG,
    );

    expect(mockSetString).toHaveBeenCalledOnce();
    expect(mockSetString).toHaveBeenCalledWith(
      ZONE_ID,
      ipxeUrl(DEVICE_UUID),
      'https://customer.example/boot.ipxe',
      TTL_IPXE_URL_SECONDS,
    );
  });

  it('does not write the custom-iPXE key on the normal OS-deploy path (ipxeUrl null)', async () => {
    await service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG);

    expect(mockSetString).not.toHaveBeenCalled();
  });

  it('swallows a custom-iPXE redis write failure and still enqueues the saga (best-effort)', async () => {
    mockSetString.mockRejectedValueOnce(new Error('redis blip'));

    await service.provisionDevice(
      DEVICE_UUID,
      JOB_ID,
      'provisioning',
      { ...LIFECYCLE_DATA, ipxeUrl: 'https://customer.example/boot.ipxe' },
      OS_SLUG,
    );

    expect(mockLogger.warn).toHaveBeenCalled();
    expect(mockEnqueueSagaJob).toHaveBeenCalledOnce();
  });

  it('passes empty customizations array to resolver when lifecycleData.customizations is null', async () => {
    await service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG);

    expect(mockResolveOsLayers).toHaveBeenCalledWith(expect.objectContaining({ customizationSlugs: [] }), JOB_ID);
  });

  it('propagates resolver errors to the caller', async () => {
    mockResolveOsLayers.mockRejectedValueOnce(
      new BadRequestException('No artifact for cuda-12.6 on ubuntu/noble/amd64'),
    );

    await expect(
      service.provisionDevice(
        DEVICE_UUID,
        JOB_ID,
        'provisioning',
        { ...LIFECYCLE_DATA, customizations: ['cuda-12.6'] },
        OS_SLUG,
      ),
    ).rejects.toThrow(/No artifact for cuda-12\.6/);

    expect(mockEnqueueSagaJob).not.toHaveBeenCalled();
  });

  it('passes arch=arm64 to the resolver when Device.architecture is "aarch64"', async () => {
    mockResolveDeviceContext.mockResolvedValueOnce({
      device: makeDevice({ architecture: 'aarch64' }),
      zoneId: ZONE_ID,
      bmcIp: '10.0.0.1',
      credentials: { bmc_user: 'admin', bmc_pass: 'secret' },
    });

    await service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG);

    expect(mockResolveOsLayers).toHaveBeenCalledWith(expect.objectContaining({ arch: 'arm64' }), JOB_ID);
  });

  it('issues a deployment OS token and nests its material inside lifecycle_data.server_token', async () => {
    await service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG);

    expect(mockIssueDeploymentOsToken).toHaveBeenCalledOnce();
    expect(mockIssueDeploymentOsToken).toHaveBeenCalledWith({
      deviceId: DEVICE_UUID,
      deploymentId: null,
      issuedBy: 'system',
    });

    expect(mockEnqueueSagaJob).toHaveBeenCalledWith(
      ZONE_ID,
      'provision',
      JOB_ID,
      expect.objectContaining({
        lifecycle_data: expect.objectContaining({
          server_token: {
            deployment_os_token: 'test-os-token',
            endpoint: 'https://brokkr.example/api/v1/bmc/phone-home',
          },
        }),
      }),
      DEVICE_UUID,
      { removeOnComplete: { count: 0 } },
    );

    const [, , , payload] = mockEnqueueSagaJob.mock.calls[0];
    expect(payload).not.toHaveProperty('server_token');
  });

  it('aborts provisioning when the pre-issued deployment token carries no material', async () => {
    await expect(
      service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG, null, {
        tokenId: 'deployment-token-id',
        displayId: 'dtok_deploy',
        plaintext: null,
        material: null,
        reused: true,
      }),
    ).rejects.toThrow(BadRequestException);

    expect(mockIssueDeploymentOsToken).not.toHaveBeenCalled();
    expect(mockEnqueueSagaJob).not.toHaveBeenCalled();
    expect(mockRevokeToken).toHaveBeenCalledWith({
      tokenId: 'deployment-token-id',
      reason: DeviceTokenRevocationReason.REPROVISION,
      note: expect.stringContaining('Deployment OS token material is required'),
      actor: 'system',
    });
  });

  it('revokes Brokkr Live tokens (no atom write) on the standard OS-deploy path', async () => {
    await service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG);

    expect(mockMintForCtx).not.toHaveBeenCalled();
    expect(mockWriteAtomBestEffort).not.toHaveBeenCalled();
    expect(mockRevokeBrokkrLiveTokensForDevice).toHaveBeenCalledWith(
      DEVICE_UUID,
      DeviceTokenRevocationReason.REPROVISION,
      `Non-iPXE provisioning cleared Brokkr Live token material for job ${JOB_ID}`,
    );
  });

  it('mints a Brokkr Live token and writes the server_token atom when a custom iPXE URL is present', async () => {
    await service.provisionDevice(
      DEVICE_UUID,
      JOB_ID,
      'provisioning',
      { ...LIFECYCLE_DATA, ipxeUrl: 'https://boot.example/custom.ipxe' },
      OS_SLUG,
    );

    const expectedTokenCtx = {
      device: { id: DEVICE_UUID },
      zoneId: ZONE_ID,
    };

    expect(mockMintForCtx).toHaveBeenCalledOnce();
    expect(mockMintForCtx).toHaveBeenCalledWith(expectedTokenCtx);

    expect(mockWriteAtomBestEffort).toHaveBeenCalledOnce();
    expect(mockWriteAtomBestEffort).toHaveBeenCalledWith(
      expectedTokenCtx,
      {
        brokkr_live_token: 'test-live-token',
        endpoint: 'https://brokkr.example/api/v1/bmc/phone-home',
        exp: 1_900_000_000,
      },
      { requestId: JOB_ID, opLabel: 'provisioning' },
    );
    expect(mockRevokeBrokkrLiveTokensForDevice).not.toHaveBeenCalled();
  });

  it('reuses the publisher-returned deploy YAML for device_data on VPC devices (no second render)', async () => {
    await service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG);

    expect(mockRenderDeployNetplan).not.toHaveBeenCalled();

    expect(mockEnqueueSagaJob).toHaveBeenCalledWith(
      ZONE_ID,
      'provision',
      JOB_ID,
      expect.objectContaining({
        device_data: {
          netplan: DEPLOY_NETPLAN_YAML,
          gpu_model: GPU_MODEL,
          purge_ttys: true,
          serial_port: OPTIMAL_SERIAL_PORT,
          serial_baud: null,
          device_type: DEVICE_MODEL_SLUG,
          network_type: NETWORK_TYPE,
        },
      }),
      DEVICE_UUID,
      { removeOnComplete: { count: 0 } },
    );
  });

  it('renders deploy-netplan for non-VPC devices and ships YAML in device_data', async () => {
    mockPublishForProvisioning.mockResolvedValueOnce({ deployNetplan: null, isVpc: false });

    await service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG);

    expect(mockRenderDeployNetplan).toHaveBeenCalledOnce();
    expect(mockRenderDeployNetplan).toHaveBeenCalledWith({
      deviceId: DEVICE_UUID,
      jobId: JOB_ID,
    });
    expect(mockEnqueueSagaJob).toHaveBeenCalledWith(
      ZONE_ID,
      'provision',
      JOB_ID,
      expect.objectContaining({
        device_data: {
          netplan: DEPLOY_NETPLAN_YAML,
          gpu_model: GPU_MODEL,
          purge_ttys: true,
          serial_port: OPTIMAL_SERIAL_PORT,
          serial_baud: null,
          device_type: DEVICE_MODEL_SLUG,
          network_type: NETWORK_TYPE,
        },
      }),
      DEVICE_UUID,
      { removeOnComplete: { count: 0 } },
    );
  });

  it('logs and ships device_data.netplan=null when fallback renderDeployNetplan throws', async () => {
    mockPublishForProvisioning.mockResolvedValueOnce({ deployNetplan: null, isVpc: false });
    mockRenderDeployNetplan.mockRejectedValueOnce(new Error('render failed'));

    await service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG);

    expect(mockRenderDeployNetplan).toHaveBeenCalledOnce();
    expect(mockLogger.warn).toHaveBeenCalled();
    expect(mockEnqueueSagaJob).toHaveBeenCalledWith(
      ZONE_ID,
      'provision',
      JOB_ID,
      expect.objectContaining({
        device_data: {
          netplan: null,
          gpu_model: GPU_MODEL,
          purge_ttys: true,
          serial_port: OPTIMAL_SERIAL_PORT,
          serial_baud: null,
          device_type: DEVICE_MODEL_SLUG,
          network_type: NETWORK_TYPE,
        },
      }),
      DEVICE_UUID,
      { removeOnComplete: { count: 0 } },
    );
  });

  it('populates device_data with gpu_model, purge_ttys, serial_port, device_type, network_type from Prisma', async () => {
    await service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG);

    expect(mockZoneFindUnique).toHaveBeenCalledWith({
      where: { id: ZONE_ID, deletedAt: null },
      select: { id: true, layerBuildId: true, eastWestNetworkType: true },
    });
    expect(mockDeviceFindUnique).toHaveBeenCalledWith({
      where: { id: DEVICE_UUID, deletedAt: null },
      select: {
        gpus: { select: { model: true }, orderBy: { index: 'asc' }, take: 1 },
        server: { select: { purgeTtys: true } },
        deviceModel: { select: { slug: true } },
        solConfig: { select: { optimalPort: true, baudRate: true, resolvedPort: true, resolvedBaud: true } },
      },
    });
    const [, , , payload] = mockEnqueueSagaJob.mock.calls[0];
    expect(payload.device_data).toEqual({
      netplan: DEPLOY_NETPLAN_YAML,
      gpu_model: GPU_MODEL,
      purge_ttys: true,
      serial_port: OPTIMAL_SERIAL_PORT,
      serial_baud: null,
      device_type: DEVICE_MODEL_SLUG,
      network_type: NETWORK_TYPE,
    });
  });

  it('coerces null Device fields into the right defaults (null / purge_ttys=false / network_type=null)', async () => {
    mockDeviceFindUnique.mockResolvedValueOnce({
      gpus: [],
      server: { purgeTtys: null },
      deviceModel: null,
      solConfig: null,
    });
    mockZoneFindUnique.mockResolvedValueOnce({ id: ZONE_ID, layerBuildId: LAYER_BUILD_ID, eastWestNetworkType: null });

    await service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG);

    const [, , , payload] = mockEnqueueSagaJob.mock.calls[0];
    expect(payload.device_data).toEqual({
      netplan: DEPLOY_NETPLAN_YAML,
      gpu_model: null,
      purge_ttys: false,
      serial_port: null,
      serial_baud: null,
      device_type: null,
      network_type: null,
    });
  });

  it('returns null when the zone has no eastWestNetworkType', async () => {
    mockZoneFindUnique.mockResolvedValueOnce({ id: ZONE_ID, layerBuildId: LAYER_BUILD_ID, eastWestNetworkType: null });

    await service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG);

    const [, , , payload] = mockEnqueueSagaJob.mock.calls[0];
    expect(payload.device_data.network_type).toBeNull();
  });

  it('lowercases the enum value: ETHERNET → ethernet', async () => {
    mockZoneFindUnique.mockResolvedValueOnce({
      id: ZONE_ID,
      layerBuildId: LAYER_BUILD_ID,
      eastWestNetworkType: 'ETHERNET',
    });

    await service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG);

    const [, , , payload] = mockEnqueueSagaJob.mock.calls[0];
    expect(payload.device_data.network_type).toBe('ethernet');
  });

  it('throws NotFoundException for missing device row before enqueueing the saga', async () => {
    mockDeviceFindUnique.mockResolvedValueOnce(null);

    await expect(service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG)).rejects.toThrow(
      NotFoundException,
    );

    expect(mockEnqueueSagaJob).not.toHaveBeenCalled();
  });

  it("derives osDistribution from slug prefix and sets osVersion to 'latest' when findBaseOsSampleBySlug returns null (artifact-less base)", async () => {
    vi.spyOn(layersModule.LayerRecord, 'findBaseOsSampleBySlug').mockResolvedValueOnce(null);

    await service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, 'ipxe-custom');

    expect(layersModule.LayerRecord.findBaseOsSampleBySlug).toHaveBeenCalledWith('ipxe-custom', LAYER_BUILD_ID);

    const [, , , payload] = mockEnqueueSagaJob.mock.calls[0];
    expect(payload.platform).toEqual({
      slug: 'ipxe-custom',
      codename: 'custom',
      os_version: 'latest',
      os_distro: 'ipxe',
      variant: 'vanilla',
    });
  });

  it('derives fallback platform for ipxe-custom-tee when findBaseOsSampleBySlug returns null', async () => {
    vi.spyOn(layersModule.LayerRecord, 'findBaseOsSampleBySlug').mockResolvedValueOnce(null);
    mockResolveDeviceContext.mockResolvedValueOnce({
      device: makeDevice({ teeCapable: TeeCapability.TRUE }),
      zoneId: ZONE_ID,
      tenantId: TENANT_ID,
      bmcIp: '10.0.0.1',
      credentials: { bmc_user: 'admin', bmc_pass: 'secret' },
    });

    await service.provisionDevice(
      DEVICE_UUID,
      JOB_ID,
      'provisioning',
      { ...LIFECYCLE_DATA, ipxeUrl: 'https://boot.example/tee.ipxe' },
      'ipxe-custom-tee',
    );

    expect(layersModule.LayerRecord.findBaseOsSampleBySlug).toHaveBeenCalledWith('ipxe-custom-tee', LAYER_BUILD_ID);

    const [, , , payload] = mockEnqueueSagaJob.mock.calls[0];
    expect(payload.platform).toEqual({
      slug: 'ipxe-custom-tee',
      codename: 'custom',
      os_version: 'latest',
      os_distro: 'ipxe',
      variant: 'tee',
    });
  });

  it('still enqueues the saga with correct fallback values when findBaseOsSampleBySlug returns null', async () => {
    vi.spyOn(layersModule.LayerRecord, 'findBaseOsSampleBySlug').mockResolvedValueOnce(null);

    await service.provisionDevice(
      DEVICE_UUID,
      JOB_ID,
      'provisioning',
      { ...LIFECYCLE_DATA, ipxeUrl: 'https://boot.example/custom.ipxe' },
      'ipxe-custom',
    );

    expect(mockEnqueueSagaJob).toHaveBeenCalledOnce();
    expect(mockEnqueueSagaJob).toHaveBeenCalledWith(
      ZONE_ID,
      'provision',
      JOB_ID,
      expect.objectContaining({
        device_id: DEVICE_UUID,
        platform: expect.objectContaining({
          os_distro: 'ipxe',
          os_version: 'latest',
        }),
      }),
      DEVICE_UUID,
      { removeOnComplete: { count: 0 } },
    );
  });

  it('defaults arch to amd64 when Device.architecture is null (pre-discovery)', async () => {
    mockResolveDeviceContext.mockResolvedValueOnce({
      device: makeDevice({ architecture: null }),
      zoneId: ZONE_ID,
      bmcIp: '10.0.0.1',
      credentials: { bmc_user: 'admin', bmc_pass: 'secret' },
    });

    await service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG);

    expect(mockResolveOsLayers).toHaveBeenCalledWith(expect.objectContaining({ arch: 'amd64' }), JOB_ID);
  });

  it('throws NotFoundException when zone is not found', async () => {
    mockZoneFindUnique.mockResolvedValueOnce(null);

    await expect(service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG)).rejects.toThrow(
      NotFoundException,
    );

    expect(mockEnqueueSagaJob).not.toHaveBeenCalled();
  });

  it('propagates error when resolveEffectiveBuild rejects', async () => {
    vi.spyOn(layersModule, 'resolveEffectiveBuild').mockRejectedValueOnce(new BadRequestException('no build'));

    await expect(service.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG)).rejects.toThrow(
      BadRequestException,
    );

    expect(mockEnqueueSagaJob).not.toHaveBeenCalled();
  });
});
