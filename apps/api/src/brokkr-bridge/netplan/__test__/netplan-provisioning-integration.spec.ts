import { Test, TestingModule } from '@nestjs/testing';
import * as layersModule from '@repo/layers';
import { LayerRecord } from '@repo/layers';
import { ConfigAtomWriter, NETPLAN_LIVE_TTL_SECONDS, netplanConfig } from 'src/common/redis';
import { DeviceSecretService } from 'src/device-secret/device-secret.service';
import { DeviceTokensService } from 'src/device-tokens/device-tokens.service';
import { NetplanService } from 'src/devices/netplan/netplan.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { Mock, vi } from 'vitest';
import { DeviceContextService } from '../../device-context.service';
import { DeviceRecordPublisher } from '../../device-record/device-record-publisher.service';
import { LifecyclePreparationService } from '../../lifecycle/lifecycle-preparation.service';
import { OsLayersResolverService } from '../../lifecycle/os-layers-resolver.service';
import { BridgeProvisionService } from '../../lifecycle/provision.service';
import { BridgeQueueService } from '../../queue/bridge-queue.service';
import { ServerTokenService } from '../../server-token/server-token.service';
import { NetplanAtomSchema } from '../netplan-atom.schema';
import { NetplanPublisherService } from '../netplan-publisher.service';
import { NetplanRedisWriterService } from '../netplan-redis-writer.service';

const DEVICE_UUID = '550e8400-e29b-41d4-a716-446655440042';
const JOB_ID = 'job-integ-001';
const OS_SLUG = 'ubuntu-noble-hpc';
const ZONE_ID = '550e8400-e29b-41d4-a716-446655440000';
const LIVE_YAML = 'network:\n  version: 2\n  ethernets:\n    enp1s0:\n      dhcp4: true\n';
const DEPLOY_YAML = 'network:\n  version: 2\n  bonds:\n    bond0:\n      interfaces: [enp1s0, enp2s0]\n';

const LIFECYCLE_DATA = {
  hostname: 'integ-host',
  diskLayouts: [{ type: 'raid1' }],
  pubkeys: ['ssh-rsa AAAA...'],
  userData: null,
  ipxeUrl: null,
  passwordHash: null,
  customizations: null,
};

function makeDevice(overrides: Partial<{ status: string; networkType: 'FLAT' | 'VPC' }> = {}) {
  return {
    id: DEVICE_UUID,
    zoneId: ZONE_ID,
    zone: { networkType: overrides.networkType ?? 'VPC' },
    status: overrides.status ?? 'INVENTORY',
    teeEnabled: false,
    ipmiBootDeviceOverride: null,
    interfaces: [{ mgmtOnly: true, macAddress: 'AA:BB:CC:DD:EE:FF', ipAddresses: [{ address: '10.0.0.1/24' }] }],
    cpus: [{ architecture: 'x86_64' }],
    supplier: { id: 'supplier-uuid' },
    gpus: [],
    purgeTtys: false,
    deviceModel: null,
    solConfig: null,
  };
}

function makeMockLogger() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    setContext: vi.fn().mockReturnThis(),
  };
}

describe('Netplan provisioning integration', () => {
  let mockRenderForDevice: Mock;
  let mockEnqueueSagaJob: Mock;
  let mockGetCurrentSealedByKind: Mock;
  let mockAtomWriteAtomJson: Mock;
  let mockAtomDeleteKeys: Mock;
  let mockIssueDeploymentOsToken: Mock;

  let mockDeviceFindFirst: Mock;
  let mockDeviceFindUnique: Mock;
  let mockDeviceUpdate: Mock;

  let provisionService: BridgeProvisionService;
  let lifecycleService: LifecyclePreparationService;

  let callOrder: string[];

  beforeEach(async () => {
    vi.stubEnv('LOCAL_SIMULATION_ENABLED', '');
    callOrder = [];

    vi.spyOn(LayerRecord, 'findBaseOsSampleBySlug').mockResolvedValue({
      osDistro: 'ubuntu',
      osCodename: 'noble',
      osVersion: '24.04',
    });

    mockRenderForDevice = vi.fn().mockImplementation(async (_deviceId: string, phase: 'live' | 'deploy') => {
      callOrder.push(`netplan:render:${phase}`);
      return phase === 'live' ? LIVE_YAML : DEPLOY_YAML;
    });

    mockEnqueueSagaJob = vi.fn().mockImplementation(async () => {
      callOrder.push('queue:enqueueSagaJob');
      return { id: 'bullmq-job-1' };
    });

    mockGetCurrentSealedByKind = vi.fn().mockResolvedValue({
      zoneId: ZONE_ID,
      zoneKeyId: 'zone-key-1',
      deviceId: DEVICE_UUID,
      purpose: 'BMC',
      kind: 'USER',
      keyGen: 1,
      ephPub: 'ZXBo',
      ciphertext: 'Y2lwaGVy',
      tag: 'dGFn',
    });
    mockIssueDeploymentOsToken = vi.fn().mockResolvedValue({
      tokenId: 'deployment-token-id',
      displayId: 'dtok_deploy',
      plaintext: 'test-os-token',
      material: {
        deployment_os_token: 'test-os-token',
        endpoint: 'https://brokkr.example/api/v1/bmc/phone-home',
        exp: 1_900_000_000,
      },
      reused: false,
    });

    mockAtomWriteAtomJson = vi.fn().mockImplementation(async () => {
      callOrder.push('atom:writeAtomJson');
      return { written: true };
    });
    mockAtomDeleteKeys = vi.fn().mockImplementation(async () => {
      callOrder.push('atom:deleteKeys');
      return undefined;
    });

    vi.spyOn(layersModule, 'resolveEffectiveBuild').mockResolvedValue('test-build-id');

    mockDeviceFindFirst = vi.fn().mockResolvedValue(makeDevice());
    mockDeviceFindUnique = vi.fn().mockResolvedValue(makeDevice());
    mockDeviceUpdate = vi.fn().mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BridgeProvisionService,
        DeviceContextService,
        LifecyclePreparationService,
        NetplanPublisherService,
        NetplanRedisWriterService,

        {
          provide: NetplanService,
          useValue: { renderForDevice: mockRenderForDevice },
        },
        {
          provide: ConfigAtomWriter,
          useValue: { writeAtomJson: mockAtomWriteAtomJson, deleteKeys: mockAtomDeleteKeys },
        },
        {
          provide: PrismaClient,
          useValue: {
            device: {
              findFirst: mockDeviceFindFirst,
              findUnique: mockDeviceFindUnique,
              update: mockDeviceUpdate,
            },
            zone: {
              findFirst: vi.fn().mockResolvedValue(null),
              findUnique: vi.fn().mockResolvedValue({ id: 'zone-1', layerBuildId: 'test-build-id' }),
            },
            deployment: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
          },
        },
        {
          provide: DeviceSecretService,
          useValue: { getCurrentSealedByKind: mockGetCurrentSealedByKind },
        },
        {
          provide: BridgeQueueService,
          useValue: { enqueueSagaJob: mockEnqueueSagaJob },
        },
        {
          provide: OsLayersResolverService,
          useValue: { resolve: vi.fn().mockResolvedValue({ entries: [], resolved: [] }) },
        },
        {
          provide: ServerTokenService,
          useValue: {
            mintForCtx: vi.fn().mockResolvedValue({
              brokkr_live_token: 'test-live-token',
              endpoint: 'https://brokkr.example/api/v1/bmc/phone-home',
              exp: 1_900_000_000,
            }),
            writeAtomForCtx: vi.fn().mockResolvedValue(undefined),
            writeAtomBestEffort: vi.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: DeviceRecordPublisher,
          useValue: { writeForDevice: vi.fn().mockResolvedValue(undefined) },
        },
        {
          provide: DeviceTokensService,
          useValue: {
            issueDeploymentOsToken: mockIssueDeploymentOsToken,
            revokeBrokkrLiveTokensForDevice: vi.fn().mockResolvedValue(undefined),
          },
        },

        { provide: `LoggerService${BridgeProvisionService.name}`, useValue: makeMockLogger() },
        { provide: `LoggerService${LifecyclePreparationService.name}`, useValue: makeMockLogger() },
        { provide: `LoggerService${NetplanPublisherService.name}`, useValue: makeMockLogger() },
        { provide: `LoggerService${NetplanRedisWriterService.name}`, useValue: makeMockLogger() },
      ],
    }).compile();

    provisionService = module.get(BridgeProvisionService);
    lifecycleService = module.get(LifecyclePreparationService);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  describe('VPC device provisioning end-to-end', () => {
    it('renders and writes both :live and :deploy netplans as envelopes, then enqueues the saga', async () => {
      await provisionService.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG);

      expect(mockRenderForDevice).toHaveBeenCalledTimes(2);
      expect(mockRenderForDevice).toHaveBeenNthCalledWith(1, DEVICE_UUID, 'live');
      expect(mockRenderForDevice).toHaveBeenNthCalledWith(2, DEVICE_UUID, 'deploy');

      expect(mockAtomWriteAtomJson).toHaveBeenCalledTimes(2);
      expect(mockAtomWriteAtomJson).toHaveBeenNthCalledWith(
        1,
        ZONE_ID,
        netplanConfig(DEVICE_UUID, 'live'),
        { yaml: LIVE_YAML },
        NetplanAtomSchema,
        NETPLAN_LIVE_TTL_SECONDS,
        { request_id: null },
      );
      expect(mockAtomWriteAtomJson).toHaveBeenNthCalledWith(
        2,
        ZONE_ID,
        netplanConfig(DEVICE_UUID, 'deploy'),
        { yaml: DEPLOY_YAML },
        NetplanAtomSchema,
        NETPLAN_LIVE_TTL_SECONDS,
        { request_id: null },
      );

      expect(mockIssueDeploymentOsToken).toHaveBeenCalledOnce();
      const [, , , vpcPayload] = mockEnqueueSagaJob.mock.calls[0];
      expect(vpcPayload.lifecycle_data.server_token).toEqual({
        deployment_os_token: 'test-os-token',
        endpoint: 'https://brokkr.example/api/v1/bmc/phone-home',
        exp: 1_900_000_000,
      });

      expect(mockEnqueueSagaJob).toHaveBeenCalledOnce();

      const atomIndices = callOrder.map((c, i) => (c === 'atom:writeAtomJson' ? i : -1)).filter((i) => i >= 0);
      const sagaIndex = callOrder.indexOf('queue:enqueueSagaJob');
      expect(sagaIndex).toBeGreaterThan(-1);
      for (const ai of atomIndices) {
        expect(ai).toBeLessThan(sagaIndex);
      }
    });
  });

  describe('Non-VPC device provisioning end-to-end', () => {
    it('writes :live atom, still renders deploy netplan for device_data payload, then enqueues the saga', async () => {
      mockDeviceFindUnique.mockResolvedValue(makeDevice({ networkType: 'FLAT' }));

      await provisionService.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG);

      expect(mockRenderForDevice).toHaveBeenCalledTimes(2);
      expect(mockRenderForDevice).toHaveBeenNthCalledWith(1, DEVICE_UUID, 'live');
      expect(mockRenderForDevice).toHaveBeenNthCalledWith(2, DEVICE_UUID, 'deploy');

      expect(mockAtomWriteAtomJson).toHaveBeenCalledTimes(1);
      expect(mockAtomWriteAtomJson).toHaveBeenCalledWith(
        ZONE_ID,
        netplanConfig(DEVICE_UUID, 'live'),
        { yaml: LIVE_YAML },
        NetplanAtomSchema,
        NETPLAN_LIVE_TTL_SECONDS,
        { request_id: null },
      );

      expect(mockEnqueueSagaJob).toHaveBeenCalledOnce();
      const [, , , payload] = mockEnqueueSagaJob.mock.calls[0];
      expect(payload).toMatchObject({ device_data: { netplan: DEPLOY_YAML } });
    });
  });

  describe('VPC deprovision end-to-end', () => {
    it('updates Prisma status, then deletes the :deploy netplan via the atom writer', async () => {
      await lifecycleService.prepareForDeprovision(DEVICE_UUID, JOB_ID);

      expect(mockDeviceUpdate).toHaveBeenCalledWith({
        where: { id: DEVICE_UUID },
        data: {
          lastJobId: JOB_ID,
          server: {
            upsert: {
              create: { lifecycleStatus: 'DEPROVISIONING' },
              update: { lifecycleStatus: 'DEPROVISIONING' },
            },
          },
        },
      });

      expect(mockAtomDeleteKeys).toHaveBeenCalledOnce();
      expect(mockAtomDeleteKeys).toHaveBeenCalledWith(ZONE_ID, [netplanConfig(DEVICE_UUID, 'deploy')]);
    });
  });

  describe('Render failure aborts provisioning', () => {
    it('throws and never enqueues the saga or writes the atom', async () => {
      mockRenderForDevice.mockReset();
      mockRenderForDevice.mockRejectedValueOnce(new Error('netplan render failed'));

      await expect(
        provisionService.provisionDevice(DEVICE_UUID, JOB_ID, 'provisioning', LIFECYCLE_DATA, OS_SLUG),
      ).rejects.toThrow(/netplan render failed/);

      expect(mockAtomWriteAtomJson).not.toHaveBeenCalled();
      expect(mockEnqueueSagaJob).not.toHaveBeenCalled();
    });
  });
});
