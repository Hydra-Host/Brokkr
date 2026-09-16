import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { CommissioningDeviceInput, CommissioningProgressItem, SagaStep, ScannedDevice } from '@repo/api-client';
import {
  Device,
  DeviceRole,
  DeviceSecretActorType,
  DeviceSecretKind,
  DeviceSecretPurpose,
  DeviceStatus,
  InterfaceType,
  JobStatus,
  JobType,
  Prisma,
  ServerLifecycleStatus,
} from '@repo/database';
import { formatMacAddress } from '@repo/database/extensions/mac-address';
import { isRecord } from '@repo/utils';
import type { JobType as BullJobType, Job } from 'bullmq';
import { randomUUID } from 'crypto';
import type Redis from 'ioredis';
import { NETWORK_SCAN_RESULT_TTL_SECONDS } from 'src/brokkr-bridge/constants/lifecycle.constants';
import { DeviceContextService, bmcSecretDispatchFields, extractBmcIp } from 'src/brokkr-bridge/device-context.service';
import { DeviceRecordPublisher } from 'src/brokkr-bridge/device-record/device-record-publisher.service';
import { BridgeCommissioningService } from 'src/brokkr-bridge/lifecycle/commissioning.service';
import { BridgeEnrichmentService } from 'src/brokkr-bridge/lifecycle/enrichment.service';
import { BridgeNetworkScanService } from 'src/brokkr-bridge/lifecycle/network-scan.service';
import { BridgePowerControlService } from 'src/brokkr-bridge/lifecycle/power-control.service';
import { BridgeQueueService } from 'src/brokkr-bridge/queue/bridge-queue.service';
import { type SagaName, sagaJobDataSchema } from 'src/brokkr-bridge/queue/bridge-queue.types';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { ensureIpAddress } from 'src/common/ipam/ensure-ip-address';
import { softDeleteDeviceNetworkAndSecrets } from 'src/common/ipam/soft-delete-device-network';
import { REDIS_CLIENT, scanKeys } from 'src/common/redis';
import { REDIS_KEYS } from 'src/common/redis/redis-keys';
import { requireZoneOwnership } from 'src/common/zone-ownership';
import { DeviceSecretService, SecretStorageUnavailableError } from 'src/device-secret/device-secret.service';
import { DeviceLifecycleEvent } from 'src/devices/device-lifecycle.events';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { resetCommissionJob, settleCommissionJob } from 'src/utils/settle-commission-job';
import { z } from 'zod';

const scanSessionSchema = z.object({
  zoneId: z.string(),
  planIds: z.array(z.string()),
  subnets: z.array(z.string()),
});

const scanSubnetResultSchema = z.object({
  errored: z.boolean().optional().default(false),
  results: z
    .record(
      z.object({
        mac: z.string().optional().default(''),
        ipmi: z.boolean().optional().default(false),
        redfish: z.boolean().optional().default(false),
      }),
    )
    .optional()
    .default({}),
});
const scanResultsMapSchema = z.record(scanSubnetResultSchema);
type ScanResultsMap = z.infer<typeof scanResultsMapSchema>;

const rawPlanStepSchema = z.object({
  step_name: z.string(),
  operation: z.string().optional().default(''),
  status: z.string(),
  started_at: z.number().nullable().optional(),
  completed_at: z.number().nullable().optional(),
  error: z.string().nullable().optional(),
});
const rawPlanSchema = z
  .object({
    plan_id: z.string().optional(),
    device_id: z.string().optional(),
    job_class: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
    created_at: z.number().optional(),
    status: z.string().optional(),
    steps: z.array(rawPlanStepSchema).optional(),
  })
  .passthrough();
type RawPlan = z.infer<typeof rawPlanSchema>;

// Structural view of the BullMQ methods the queue sweep uses — lets one helper drive both the
// hub's LifecycleJobData queue and the (differently typed) collection queue.
interface SweepableQueue {
  getJobs: (types: BullJobType[]) => Promise<Array<Pick<Job, 'id' | 'data' | 'getState' | 'discard' | 'remove'>>>;
}

function scanSessionKey(sessionId: string): string {
  return `commissioning:scan-session:${sessionId}`;
}

// Enrich plans have no Device row and their bridge saga plan is TTL'd; absence past this
// grace window means the plan expired (or never persisted), not that it is still pending.
const ENRICH_PLAN_GRACE_MS = 20 * 60 * 1_000;
function enrichPlanStartedKey(zoneId: string, planId: string): string {
  return `commissioning:enrich-started:${zoneId}:${planId}`;
}

const COMMISSION_NAME_UNIQUE_INDEX = 'Device_active_commissioning_name_unique';
const PG_UNIQUE_VIOLATION = '23505';
function isDuplicateCommissionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = error.meta?.target;
    if (Array.isArray(target)) return target.includes('zoneId') && target.includes('name');
    return String(target ?? '').includes(COMMISSION_NAME_UNIQUE_INDEX);
  }
  if (error instanceof Error) {
    const cause = error.cause;
    const code = isRecord(cause) && typeof cause.code === 'string' ? cause.code : null;
    const causeMessage = isRecord(cause) && typeof cause.message === 'string' ? cause.message : '';
    if (code === PG_UNIQUE_VIOLATION) {
      return (
        error.message.includes(COMMISSION_NAME_UNIQUE_INDEX) || causeMessage.includes(COMMISSION_NAME_UNIQUE_INDEX)
      );
    }
  }
  return false;
}

function commissioningStatusFromLifecycle(
  match: { lifecycleStatus: ServerLifecycleStatus | null } | undefined,
): ScannedDevice['commissioningStatus'] {
  if (!match) return 'Detected';
  const lc = match.lifecycleStatus;
  if (lc === ServerLifecycleStatus.FAILED) return 'Failed';
  if (lc === ServerLifecycleStatus.INVENTORY) return 'Done';
  return 'InProgress';
}

@Injectable()
export class CommissioningService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly bridgeNetworkScanService: BridgeNetworkScanService,
    private readonly bridgeEnrichmentService: BridgeEnrichmentService,
    private readonly bridgeCommissioningService: BridgeCommissioningService,
    private readonly bridgePowerControlService: BridgePowerControlService,
    private readonly bridgeQueueService: BridgeQueueService,
    private readonly deviceContextService: DeviceContextService,
    private readonly prisma: PrismaClient,
    private readonly contextService: ContextService,
    private readonly eventEmitter: EventEmitter2,
    private readonly deviceSecretService: DeviceSecretService,
    private readonly deviceRecordPublisher: DeviceRecordPublisher,
    @Logger(CommissioningService.name) private readonly logger: LoggerService,
  ) {}

  private requireCommissioningRole(): void {
    this.contextService.requirePermission('device', 'create');
  }

  private async requireZone(zoneId: string): Promise<{ id: string; organizationId: string }> {
    return requireZoneOwnership(this.prisma, zoneId, this.contextService.organizationId);
  }

  private async requireCommissioningDevice(
    zoneId: string,
    deviceId: string,
  ): Promise<{ id: string; zoneId: string | null }> {
    const organizationId = this.contextService.organizationId;
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId, supplierId: organizationId, zoneId, role: null, deletedAt: null },
      select: { id: true, zoneId: true },
    });
    if (!device) throw new NotFoundException(`Commissioning device ${deviceId} not found`);
    return device;
  }

  private planMatchesDevice(plan: RawPlan, deviceId: string | null): boolean {
    if (!deviceId) return false;
    return plan.plan_id === deviceId || plan.device_id === deviceId;
  }

  private async getManagementSubnets(zoneId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ prefix: string }>>(Prisma.sql`
      SELECT
        p.prefix::text AS prefix
      FROM
        "Prefix" p
      WHERE
        p."zoneId" = ${zoneId}
        AND p."deletedAt" IS NULL
        AND p.role = 'MANAGEMENT'::"IpamRole"
      ORDER BY p.prefix
    `);
    return rows.map((r) => r.prefix);
  }

  private async normalizeSubnets(subnets: string[]): Promise<string[]> {
    const normalized: string[] = [];
    for (const subnet of subnets) {
      const rows = await this.prisma.$queryRaw<Array<{ normalized: string }>>(
        Prisma.sql`SELECT network(${subnet}::inet)::text AS normalized`,
      );
      const value = rows[0]?.normalized;
      if (!value) {
        throw new BadRequestException(`Invalid subnet: ${subnet}`);
      }
      normalized.push(value);
    }
    return normalized;
  }

  async listManagementSubnets(zoneId: string): Promise<{ subnets: string[] }> {
    this.requireCommissioningRole();
    await this.requireZone(zoneId);
    const subnets = await this.getManagementSubnets(zoneId);
    return { subnets };
  }

  async scanZoneManagementSubnets(
    zoneId: string,
    subnetsOverride?: string[],
  ): Promise<{ sessionId: string; subnets: string[] }> {
    this.requireCommissioningRole();
    await this.requireZone(zoneId);

    const subnets = subnetsOverride?.length
      ? await this.normalizeSubnets(subnetsOverride)
      : await this.getManagementSubnets(zoneId);
    if (subnets.length === 0) {
      throw new BadRequestException('Zone has no MANAGEMENT subnets to scan');
    }

    const planIds: string[] = [];
    for (const subnet of subnets) {
      const { planId } = await this.bridgeNetworkScanService.startScan(zoneId, subnet);
      planIds.push(planId);
    }

    const sessionId = `scan-session-${randomUUID()}`;
    await this.redis.set(
      scanSessionKey(sessionId),
      JSON.stringify({ zoneId, planIds, subnets }),
      'EX',
      NETWORK_SCAN_RESULT_TTL_SECONDS,
    );

    return { sessionId, subnets };
  }

  async pollScanSession(
    zoneId: string,
    sessionId: string,
  ): Promise<{
    status: 'pending' | 'complete' | 'failed';
    result?: { devices: ScannedDevice[]; total: number; partial: boolean; subnetsTotal: number; subnetsFailed: number };
    error?: string;
  }> {
    this.requireCommissioningRole();
    const zone = await this.requireZone(zoneId);

    const raw = await this.redis.get(scanSessionKey(sessionId));
    if (!raw) throw new NotFoundException('Scan session not found or expired');
    const session = scanSessionSchema.parse(JSON.parse(raw));
    if (session.zoneId !== zoneId) throw new NotFoundException('Scan session not found or expired');

    const polls = await Promise.all(
      session.planIds.map((planId) => this.bridgeNetworkScanService.getScanResult(planId)),
    );

    if (polls.some((p) => p.status === 'pending')) {
      return { status: 'pending' };
    }

    const completed = polls.filter((p) => p.status === 'complete' && p.result);
    if (completed.length === 0) {
      return { status: 'failed', error: polls.find((p) => p.error)?.error ?? 'All subnet scans failed' };
    }
    const subnetsFailed = polls.length - completed.length;

    const merged: Record<string, unknown> = {};
    for (const poll of completed) {
      const stepOutput = poll.result!.scanResults;
      const subnetMap = (stepOutput.results ?? stepOutput) as Record<string, unknown>;
      Object.assign(merged, subnetMap);
    }

    const parsedResults = scanResultsMapSchema.safeParse(merged);
    if (!parsedResults.success) {
      this.logger.warn(`Scan session ${sessionId} returned malformed results: ${parsedResults.error.message}`);
      return { status: 'failed', error: 'Scan returned malformed results' };
    }
    const devices = await this.findNewDevicesFromScanResults(parsedResults.data, zoneId, zone.organizationId);
    return {
      status: 'complete',
      result: {
        devices,
        total: devices.length,
        partial: subnetsFailed > 0,
        subnetsTotal: polls.length,
        subnetsFailed,
      },
    };
  }

  private async findNewDevicesFromScanResults(
    scanResults: ScanResultsMap,
    zoneId: string,
    organizationId: string,
  ): Promise<ScannedDevice[]> {
    const allIps: string[] = [];
    const ipToScanDataMap = new Map<string, { mac: string; hasIpmi: boolean; hasRedfish: boolean }>();

    for (const subnetResult of Object.values(scanResults)) {
      if (subnetResult.errored) continue;
      for (const [ip, deviceInfo] of Object.entries(subnetResult.results)) {
        const mac = deviceInfo.mac && deviceInfo.mac !== 'N/A' ? deviceInfo.mac.toUpperCase() : '';
        allIps.push(ip);
        ipToScanDataMap.set(ip, { mac, hasIpmi: deviceInfo.ipmi, hasRedfish: deviceInfo.redfish });
      }
    }
    if (allIps.length === 0) return [];

    const uniqueIps = [...new Set(allIps)];

    const knownMacs = [...new Set(uniqueIps.map((ip) => ipToScanDataMap.get(ip)!.mac).filter(Boolean))];
    const ipsWithoutMac = uniqueIps.filter((ip) => !ipToScanDataMap.get(ip)!.mac);

    const inProgressByMac = new Map<string, { lifecycleStatus: ServerLifecycleStatus | null }>();
    const completedMacs = new Set<string>();
    const inProgressByIp = new Map<string, { lifecycleStatus: ServerLifecycleStatus | null }>();
    const completedIps = new Set<string>();

    if (knownMacs.length > 0) {
      const interfaces = await this.prisma.interface.findMany({
        where: {
          OR: knownMacs.map((mac) => ({ macAddress: { equals: mac, mode: 'insensitive' as const } })),
          deletedAt: null,
          // Management IPs/MACs aren't globally unique — another tenant's device at the same address must not exclude or leak status here.
          device: { deletedAt: null, supplierId: organizationId, zoneId },
        },
        select: { macAddress: true, device: { select: { role: true, server: { select: { lifecycleStatus: true } } } } },
      });
      for (const iface of interfaces) {
        if (!iface.macAddress) continue;
        const mac = iface.macAddress.toUpperCase();
        if (iface.device.role === null) {
          inProgressByMac.set(mac, { lifecycleStatus: iface.device.server?.lifecycleStatus ?? null });
        } else {
          completedMacs.add(mac);
        }
      }
    }

    if (ipsWithoutMac.length > 0) {
      const rows = await this.prisma.$queryRaw<
        Array<{ address: string; deviceRole: string | null; lifecycleStatus: ServerLifecycleStatus | null }>
      >(Prisma.sql`
        SELECT
          host(ip.address) AS address,
          d."role" AS "deviceRole",
          s."lifecycleStatus"
        FROM
          "IpAddress" ip
        JOIN "Interface" i ON
          i.id = ip."interfaceId"
          AND i."mgmtOnly"
          AND i."deletedAt" IS NULL
        JOIN "Device" d ON
          d.id = i."deviceId"
          AND d."deletedAt" IS NULL
          AND d."supplierId" = ${organizationId}
          AND d."zoneId" = ${zoneId}
        LEFT JOIN "Server" s ON
          s."deviceId" = d.id
        WHERE
          ip."deletedAt" IS NULL
          AND host(ip.address) IN (${Prisma.join(ipsWithoutMac)})
      `);
      for (const r of rows) {
        if (r.deviceRole === null) inProgressByIp.set(r.address, { lifecycleStatus: r.lifecycleStatus });
        else completedIps.add(r.address);
      }
    }

    const newDevices: ScannedDevice[] = uniqueIps
      .filter((ip) => {
        const { mac } = ipToScanDataMap.get(ip)!;
        return mac ? !completedMacs.has(mac) : !completedIps.has(ip);
      })
      .map((ip) => {
        const scanData = ipToScanDataMap.get(ip)!;
        const match = scanData.mac ? inProgressByMac.get(scanData.mac) : inProgressByIp.get(ip);
        return {
          id: null,
          bmcMac: scanData.mac,
          bmcIp: ip,
          nicMac: '',
          nicIp: '',
          hasIpmi: scanData.hasIpmi,
          hasRedfish: scanData.hasRedfish,
          serial: '',
          boardSerial: '',
          chassisSerial: '',
          manufacturer: '',
          enriched: false,
          commissioningStatus: commissioningStatusFromLifecycle(match),
        };
      });

    await this.enrichWithPendingDeviceData(newDevices, zoneId);
    return newDevices;
  }

  private normalizeDiscoveryIp(raw: string): string {
    const s = raw.trim();
    if (!s) return '';
    const host = s.includes('/') ? s.slice(0, s.indexOf('/')) : s;
    return host.trim().toLowerCase();
  }

  private async enrichWithPendingDeviceData(devices: ScannedDevice[], zoneId: string): Promise<void> {
    try {
      const pendingKeys = await scanKeys(this.redis, REDIS_KEYS.discoveryPending(zoneId));
      if (pendingKeys.length === 0) return;

      const pipeline = this.redis.pipeline();
      for (const key of pendingKeys) pipeline.hgetall(key);
      const results = await pipeline.exec();
      if (!results) return;

      const enrichmentMap = new Map<string, Record<string, string>>();
      const enrichmentByIp = new Map<string, Record<string, string>>();
      for (let i = 0; i < pendingKeys.length; i++) {
        const [err, data] = results[i];
        if (err || !data || typeof data !== 'object') continue;
        const d = data as Record<string, string>;
        ['mac', 'ipmi_mac'].forEach((key) => {
          if (d[key]) enrichmentMap.set(d[key].replace(/[:-]/g, '').toUpperCase(), d);
        });
        ['ipmi_ip', 'ip'].forEach((key) => {
          if (d[key]) enrichmentByIp.set(this.normalizeDiscoveryIp(d[key]), d);
        });
      }

      for (const device of devices) {
        const normalizedMac = device.bmcMac?.replace(/[:-]/g, '').toUpperCase() ?? '';
        let enrichment: Record<string, string> | undefined;
        if (normalizedMac) enrichment = enrichmentMap.get(normalizedMac);
        if (!enrichment && device.bmcIp) {
          const ipKey = this.normalizeDiscoveryIp(device.bmcIp);
          if (ipKey) enrichment = enrichmentByIp.get(ipKey);
        }
        if (!enrichment) continue;

        device.nicMac = enrichment.mac ?? '';
        device.nicIp = enrichment.ip ?? '';
        device.serial = enrichment.serial || enrichment.board_serial || enrichment.chassis_serial || '';
        device.boardSerial = enrichment.board_serial ?? '';
        device.chassisSerial = enrichment.chassis_serial ?? '';
        device.manufacturer = enrichment.manufacturer ?? '';
        device.enriched = true;

        if (!device.bmcMac && enrichment.ipmi_mac) {
          device.bmcMac = enrichment.ipmi_mac;
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to enrich devices with Redis pending data: ${getErrorMessage(error)}`);
    }
  }

  async enrichDevice(
    zoneId: string,
    request: { bmcIp: string; bmcUsername: string; bmcPassword: string },
  ): Promise<{ success: boolean; planId: string }> {
    this.requireCommissioningRole();
    await this.requireZone(zoneId);
    try {
      // Seal creds ephemerally (no DB row) — enrich_via_pxe never carries plaintext creds.
      const planId = `enrich-${randomUUID()}`;
      const bmcSecret = await this.deviceSecretService.sealEphemeral(
        zoneId,
        planId,
        DeviceSecretPurpose.BMC,
        DeviceSecretKind.USER,
        { user: request.bmcUsername, pass: request.bmcPassword },
        { type: DeviceSecretActorType.USER, id: this.contextService.userId },
      );
      await this.redis.set(enrichPlanStartedKey(zoneId, planId), String(Date.now()), 'PX', ENRICH_PLAN_GRACE_MS);
      return await this.bridgeEnrichmentService.startEnrichment(zoneId, request.bmcIp, bmcSecret, planId);
    } catch (error) {
      if (error instanceof SecretStorageUnavailableError) {
        this.logger.warn(`[Commissioning] Enrichment unavailable for zone ${zoneId}: ${error.message}`);
        throw new ServiceUnavailableException(
          `Cannot enrich: BMC credentials can't be sealed for this zone yet (${error.message}). ` +
            `The zone must be enrolled in zone-crypto before enrichment.`,
        );
      }
      this.logger.error(`Enrichment enqueue failed: ${getErrorMessage(error)}`);
      throw error;
    }
  }

  async pollEnrichmentStatus(
    zoneId: string,
    planId: string,
  ): Promise<{ status: 'pending' | 'complete' | 'failed' | 'expired'; error: string | null }> {
    this.requireCommissioningRole();
    await this.requireZone(zoneId);

    const raw = await this.redis.get(REDIS_KEYS.sagaPlanById(zoneId, planId));
    if (!raw) return { status: await this.enrichPendingOrExpired(zoneId, planId), error: null };

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error) {
      this.logger.warn(`[Commissioning] Non-JSON enrich plan ${planId}: ${getErrorMessage(error)}`);
      return { status: 'pending', error: null };
    }
    const parsed = rawPlanSchema.safeParse(json);
    if (!parsed.success) {
      this.logger.warn(`[Commissioning] Malformed enrich plan ${planId}: ${parsed.error.message}`);
      return { status: 'pending', error: null };
    }
    const plan = parsed.data;

    if (plan.status === 'cancelled') return { status: 'expired', error: null };
    const failedStep = (plan.steps ?? []).find((s) => s.status === 'failed');
    if (failedStep || plan.status === 'failed') {
      const error = failedStep?.error ?? `Enrichment saga ${planId} failed`;
      return { status: 'failed', error };
    }
    if (plan.status === 'complete') return { status: 'complete', error: null };
    return { status: await this.enrichPendingOrExpired(zoneId, planId), error: null };
  }

  // Started marker shares the plan TTL: missing means abandoned (prompt rescan).
  // Marker inside the grace window means the device is still booting (pending).
  private async enrichPendingOrExpired(zoneId: string, planId: string): Promise<'pending' | 'expired'> {
    const startedRaw = await this.redis.get(enrichPlanStartedKey(zoneId, planId));
    if (!startedRaw) return 'expired';
    const startedAt = Number(startedRaw);
    if (!Number.isFinite(startedAt)) return 'pending';
    return Date.now() - startedAt >= ENRICH_PLAN_GRACE_MS ? 'expired' : 'pending';
  }

  async cancelEnrichment(zoneId: string, planId: string): Promise<{ success: boolean; message: string }> {
    this.requireCommissioningRole();
    await this.requireZone(zoneId);
    // Enrich plan ids are minted `enrich-<uuid>`; reject anything else so a device UUID can't be used to
    // cancel a real commissioning device's saga plan / BullMQ jobs through this endpoint.
    if (!planId.startsWith('enrich-')) {
      throw new BadRequestException('Not an enrich plan id');
    }

    await this.cancelEnrichBridgeJobs(zoneId, planId);
    await this.cancelRedisEnrichPlan(zoneId, planId);
    await this.redis.del(enrichPlanStartedKey(zoneId, planId));

    this.logger.log(`[Commissioning] Cancelled enrichment plan=${planId} zone=${zoneId}`);
    return { success: true, message: 'Enrichment cancelled' };
  }

  private async cancelRedisEnrichPlan(zoneId: string, planId: string): Promise<void> {
    try {
      const key = REDIS_KEYS.sagaPlanById(zoneId, planId);
      const raw = await this.redis.get(key);
      if (!raw) return;
      const parsed = rawPlanSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return;
      const plan = parsed.data;
      if (['complete', 'failed', 'cancelled'].includes(String(plan.status))) return;
      plan.status = 'cancelled';
      plan.completed_at = Date.now() / 1000;
      await this.redis.set(key, JSON.stringify(plan), 'KEEPTTL');
    } catch (error) {
      this.logger.warn(`[Commissioning] Failed to cancel enrich plan ${planId}: ${getErrorMessage(error)}`);
    }
  }

  async refreshEnrichment(zoneId: string, devices: ScannedDevice[]): Promise<ScannedDevice[]> {
    this.requireCommissioningRole();
    await this.requireZone(zoneId);
    await this.enrichWithPendingDeviceData(devices, zoneId);
    return devices;
  }

  async validateCommissioning(zoneId: string, devices: CommissioningDeviceInput[]) {
    this.requireCommissioningRole();
    await this.requireZone(zoneId);
    if (!devices || !Array.isArray(devices) || devices.length === 0) {
      throw new BadRequestException('No devices provided for commissioning');
    }

    const testPromises = devices.map(async (device) => {
      const baseReturn = {
        bmcIp: device.bmcIp || '',
      };

      if (!device.bmcUsername || !device.bmcPassword) {
        return {
          ...baseReturn,
          success: false,
          message: `IPMI credentials missing - Username: ${device.bmcUsername ? 'OK' : 'MISSING'}, Password: ${device.bmcPassword ? 'OK' : 'MISSING'}`,
        };
      }
      if (!device.bmcIp) {
        return {
          ...baseReturn,
          bmcIp: '',
          success: false,
          message: 'IPMI IP address is required for connectivity test',
        };
      }

      const jobId = randomUUID();
      try {
        // Seal creds ephemerally (no DB row) — power_status never sees plaintext.
        const bmcSecret = await this.deviceSecretService.sealEphemeral(
          zoneId,
          jobId,
          DeviceSecretPurpose.BMC,
          DeviceSecretKind.USER,
          { user: device.bmcUsername, pass: device.bmcPassword },
          { type: DeviceSecretActorType.USER, id: this.contextService.userId },
        );
        const bullmqJob = await this.bridgePowerControlService.checkPowerStatus(zoneId, device.bmcIp, bmcSecret, jobId);
        const state = await this.bridgePowerControlService.waitForJobCompletion(bullmqJob, zoneId);
        return {
          ...baseReturn,
          success: state === 'completed',
          message: state === 'completed' ? 'IPMI connectivity test passed' : 'IPMI validation failed',
        };
      } catch (error) {
        if (error instanceof SecretStorageUnavailableError) {
          return {
            ...baseReturn,
            success: false,
            message: `Cannot validate: BMC credentials can't be sealed for this zone yet (${error.message}). The zone must be enrolled in zone-crypto.`,
          };
        }
        return { ...baseReturn, success: false, message: `IPMI connectivity test failed: ${getErrorMessage(error)}` };
      }
    });

    const settled = await Promise.allSettled(testPromises);
    const ipmiTestResults = settled.map((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      const device = devices[index];
      return {
        bmcIp: device.bmcIp || '',
        success: false,
        message: `IPMI connectivity test failed: ${getErrorMessage(result.reason)}`,
      };
    });

    const successfulTests = ipmiTestResults.filter((r) => r.success).length;
    const failedTests = ipmiTestResults.filter((r) => !r.success).length;

    return {
      success: true,
      message: `Device validation completed. IPMI: ${successfulTests}/${devices.length} passed.`,
      ipmiTestResults,
      totalDevices: devices.length,
      successfulTests,
      failedTests,
    };
  }

  async commissionDevices(zoneId: string, devices: CommissioningDeviceInput[]) {
    this.requireCommissioningRole();
    const { organizationId } = await this.requireZone(zoneId);
    if (!devices || !Array.isArray(devices) || devices.length === 0) {
      throw new BadRequestException('No devices provided for commissioning');
    }

    const deviceIds: string[] = [];
    const failedDevices: Array<{ bmcMac: string; error: string }> = [];

    for (const device of devices) {
      try {
        const enrichment = device.nicMac
          ? { nicMac: device.nicMac, nicIp: device.nicIp, serial: device.serial }
          : undefined;

        const deviceRecord = await this.prisma.$transaction(
          async (tx) => {
            const deviceRecord = await this.createCommissioningDevice(
              tx,
              {
                zoneId,
                organizationId,
                bmcMac: device.bmcMac,
                bmcIp: device.bmcIp,
                osIp: device.osIp,
              },
              enrichment,
            );

            await this.saveBmcCredentials(
              { deviceId: deviceRecord.id, bmcUser: device.bmcUsername, bmcPass: device.bmcPassword },
              tx,
            );

            return deviceRecord;
          },
          { timeout: 15_000 },
        );
        this.logger.log(
          `[Commissioning] Created commissioning device ${deviceRecord.id} (role=null) for ${device.bmcMac}`,
        );

        try {
          const published = await this.deviceRecordPublisher.writeForDevice(deviceRecord.id);
          DeviceRecordPublisher.warnIfPublishSkipped(this.logger, published, 'commission', deviceRecord.id);
        } catch (publishErr) {
          this.logger.warn(
            `[Commissioning] device_record publish failed for ${deviceRecord.id} (non-fatal; render-on-miss backstop): ${getErrorMessage(publishErr)}`,
          );
        }

        try {
          await this.prisma.job.create({
            data: {
              id: deviceRecord.id,
              jobType: JobType.Commission,
              status: JobStatus.Pending,
              device: { connect: { id: deviceRecord.id } },
              job: {
                zoneId,
                bmcMacAddress: device.bmcMac,
                bmcIp: device.bmcIp ?? null,
              },
            },
          });
          const deviceContext = device.bmcIp ? { bmcIp: device.bmcIp } : undefined;
          await this.bridgeCommissioningService.commissionDevice(
            deviceRecord.id,
            deviceRecord.id,
            {},
            zoneId,
            deviceContext,
          );
          this.logger.log(`[Commissioning] Commission saga enqueued for device ${deviceRecord.id}`);
        } catch (postErr) {
          await this.softDeleteCommissioningDevice(deviceRecord.id, getErrorMessage(postErr)).catch((cleanupErr) =>
            this.logger.error(
              `[Commissioning] CRITICAL: enqueue failed AND teardown failed for device ${deviceRecord.id} — ` +
                `orphaned role=null device with sealed creds, needs manual cleanup: ${getErrorMessage(cleanupErr)}`,
            ),
          );
          throw postErr;
        }

        deviceIds.push(deviceRecord.id);
      } catch (error) {
        const errorMsg = isDuplicateCommissionError(error)
          ? `BMC ${device.bmcMac} already exists in this data center`
          : getErrorMessage(error);
        this.logger.error(`[Commissioning] Failed for ${device.bmcMac}: ${errorMsg}`);
        failedDevices.push({ bmcMac: device.bmcMac, error: errorMsg });
      }
    }

    const allFailed = deviceIds.length === 0 && devices.length > 0;
    return {
      success: !allFailed,
      message: allFailed
        ? 'Failed to commission any devices'
        : `Commissioning started for ${deviceIds.length}/${devices.length} devices.`,
      processedDevices: devices.length,
      createdCount: deviceIds.length,
      failedCount: failedDevices.length,
      deviceIds,
      failedDevices: failedDevices.length > 0 ? failedDevices : undefined,
    };
  }

  private async createCommissioningDevice(
    tx: Prisma.TransactionClient,
    input: {
      zoneId: string;
      organizationId: string;
      bmcMac: string;
      bmcIp: string | null;
      osIp: string | null;
    },
    enrichment?: { nicMac?: string; nicIp?: string; serial?: string },
  ): Promise<Device> {
    const bmcIp = input.bmcIp && input.bmcIp.trim() !== '' ? input.bmcIp.split('/')[0] : null;

    const device = await tx.device.create({
      data: {
        name: input.bmcMac.replace(/[^a-f0-9]/gi, '').toLowerCase(),
        role: null,
        status: DeviceStatus.PLANNED,
        zoneId: input.zoneId,
        supplierId: input.organizationId,
        systemSerial: enrichment?.serial || null,
      },
    });

    const ipmiInterface = await tx.interface.create({
      data: {
        deviceId: device.id,
        name: 'IPMI',
        macAddress: input.bmcMac,
        type: InterfaceType.IPMI_BMC,
        mgmtOnly: true,
        markConnected: true,
      },
    });
    if (bmcIp) {
      const outcome = await ensureIpAddress(tx, {
        address: await this.composeAddressWithPrefixMask(tx, bmcIp, input.zoneId),
        interfaceId: ipmiInterface.id,
        deviceId: device.id,
        organizationId: input.organizationId,
      });
      if (outcome === 'invalid' || outcome === 'assigned-elsewhere') {
        throw new BadRequestException(`BMC IP ${bmcIp} could not be assigned (${outcome})`);
      }
    }

    const eth0Ip = input.osIp || enrichment?.nicIp || null;
    if (enrichment?.nicMac || eth0Ip) {
      const nicMac = enrichment?.nicMac ?? null;
      // A shared-LAN BMC can answer with the host NIC's MAC; the per-device MAC index rejects a second row.
      const bmcSharesNicMac = nicMac !== null && formatMacAddress(nicMac) === formatMacAddress(input.bmcMac);
      if (bmcSharesNicMac) {
        this.logger.warn(`[Commissioning] BMC ${input.bmcMac} shares the NIC MAC — creating eth0 without one`);
      }
      const nicInterface = await tx.interface.create({
        data: {
          deviceId: device.id,
          name: 'eth0',
          macAddress: bmcSharesNicMac ? null : nicMac,
          markConnected: true,
        },
      });
      if (eth0Ip) {
        const outcome = await ensureIpAddress(tx, {
          address: await this.composeAddressWithPrefixMask(tx, eth0Ip, input.zoneId),
          interfaceId: nicInterface.id,
          deviceId: device.id,
          organizationId: input.organizationId,
        });
        if (outcome === 'invalid' || outcome === 'assigned-elsewhere') {
          throw new BadRequestException(`Primary IP ${eth0Ip} could not be assigned (${outcome})`);
        }
      }
    }

    return device;
  }

  /** Saga dispatch fails closed without a sealed BMC secret, so a failed seal must throw and abort the device-creation transaction up front. */
  private async saveBmcCredentials(
    input: { deviceId: string; bmcUser: string; bmcPass: string },
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!input.bmcUser || !input.bmcPass) return;
    await this.deviceSecretService.write(
      input.deviceId,
      DeviceSecretPurpose.BMC,
      DeviceSecretKind.USER,
      { user: input.bmcUser, pass: input.bmcPass },
      this.contextService.userId,
      { skipIfLivePresent: true, tx },
    );
    this.logger.log(`[Commissioning] Sealed BMC credentials for device ${input.deviceId}`);
  }

  async getCommissioningProgress(zoneId: string): Promise<{ success: boolean; data: CommissioningProgressItem[] }> {
    this.requireCommissioningRole();
    const { organizationId } = await this.requireZone(zoneId);

    try {
      const devices = await this.prisma.device.findMany({
        where: {
          supplierId: organizationId,
          zoneId,
          role: null,
          deletedAt: null,
          interfaces: { some: { type: InterfaceType.IPMI_BMC, deletedAt: null } },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          zoneId: true,
          createdAt: true,
          updatedAt: true,
          systemSerial: true,
          server: { select: { lifecycleStatus: true } },
          interfaces: {
            where: { deletedAt: null },
            select: {
              type: true,
              macAddress: true,
              mgmtOnly: true,
              ipAddresses: { where: { deletedAt: null }, select: { address: true }, take: 1 },
            },
          },
        },
      });

      const zoneStatuses = await this.prisma.zoneStatus.findMany({
        where: { zoneId },
        select: { isOnline: true },
      });
      const zoneOnline = zoneStatuses.some((z) => z.isOnline);

      const sagaStepsByDeviceId = await this.fetchSagaStepsForDevices(
        devices.map((d) => ({ id: d.id, zoneId: d.zoneId })),
      );

      const data: CommissioningProgressItem[] = devices.map((d) => {
        const ipmi =
          d.interfaces.find((i) => i.type === InterfaceType.IPMI_BMC) ?? d.interfaces.find((i) => i.mgmtOnly);
        const nic = d.interfaces.find((i) => i !== ipmi && !i.mgmtOnly);
        const bmcIpRaw = ipmi?.ipAddresses[0]?.address ?? null;
        const nicIpRaw = nic?.ipAddresses[0]?.address ?? null;
        return {
          deviceId: d.id,
          bmcMac: ipmi?.macAddress ?? null,
          bmcIp: bmcIpRaw != null ? bmcIpRaw.split('/')[0] : null,
          nicMac: nic?.macAddress ?? null,
          nicIp: nicIpRaw != null ? nicIpRaw.split('/')[0] : null,
          serial: d.systemSerial ?? null,
          deviceStatus: d.status,
          zoneId: d.zoneId,
          zoneOnline,
          lifecycleFailed: d.server?.lifecycleStatus === ServerLifecycleStatus.FAILED,
          lifecycleQualified: d.server?.lifecycleStatus === ServerLifecycleStatus.INVENTORY,
          sagaSteps: sagaStepsByDeviceId.get(d.id) ?? [],
          createdAt: d.createdAt.toISOString(),
          updatedAt: d.updatedAt.toISOString(),
        };
      });

      return { success: true, data };
    } catch (error) {
      this.logger.error(`Failed to fetch commissioning progress for zone ${zoneId}: ${getErrorMessage(error)}`);
      throw new BadRequestException(`Failed to fetch commissioning progress: ${getErrorMessage(error)}`);
    }
  }

  private async fetchSagaStepsForDevices(
    records: Array<{ id: string; zoneId: string | null }>,
  ): Promise<Map<string, SagaStep[]>> {
    const stepsByDeviceId = new Map<string, SagaStep[]>();
    for (const record of records) stepsByDeviceId.set(record.id, []);
    if (records.length === 0) return stepsByDeviceId;

    const recordsByZone = new Map<string, string[]>();
    for (const record of records) {
      if (!record.zoneId) continue;
      const group = recordsByZone.get(record.zoneId) ?? [];
      group.push(record.id);
      recordsByZone.set(record.zoneId, group);
    }

    await Promise.all(
      [...recordsByZone.entries()].map(async ([zoneUuid, deviceIds]) => {
        try {
          const zoneSteps = await this.fetchSagaStepsForZone(zoneUuid, deviceIds);
          for (const [deviceId, steps] of zoneSteps) stepsByDeviceId.set(deviceId, steps);
        } catch (error) {
          this.logger.warn(`Failed to fetch saga steps for zone ${zoneUuid}: ${getErrorMessage(error)}`);
        }
      }),
    );

    return stepsByDeviceId;
  }

  private async fetchSagaStepsForZone(zoneUuid: string, deviceIds: string[]): Promise<Map<string, SagaStep[]>> {
    const latestPlanByPhaseByDevice = new Map<
      string,
      Map<string, { createdAt: number; steps: z.infer<typeof rawPlanStepSchema>[] }>
    >();
    for (const deviceId of deviceIds) latestPlanByPhaseByDevice.set(deviceId, new Map());

    const planKeys = await scanKeys(this.redis, REDIS_KEYS.sagaPlan(zoneUuid));
    if (planKeys.length === 0) return this.sagaStepsMapsFromPlanPhases(latestPlanByPhaseByDevice);

    const pipeline = this.redis.pipeline();
    for (const key of planKeys) pipeline.get(key);
    const results = await pipeline.exec();
    if (!results) return this.sagaStepsMapsFromPlanPhases(latestPlanByPhaseByDevice);

    for (const [err, data] of results) {
      if (err || typeof data !== 'string') continue;
      const parsed = rawPlanSchema.safeParse(JSON.parse(data));
      if (!parsed.success) continue;
      const plan = parsed.data;

      const phase = String(
        plan.job_class ?? (plan.metadata as Record<string, unknown> | undefined)?.saga_name ?? 'unknown',
      );
      const createdAt = Number(plan.created_at ?? 0);
      const planSteps = plan.steps ?? [];

      for (const deviceId of deviceIds) {
        if (!this.planMatchesDevice(plan, deviceId)) continue;
        const phaseMap = latestPlanByPhaseByDevice.get(deviceId)!;
        const existing = phaseMap.get(phase);
        if (!existing || createdAt > existing.createdAt) phaseMap.set(phase, { createdAt, steps: planSteps });
      }
    }

    return this.sagaStepsMapsFromPlanPhases(latestPlanByPhaseByDevice);
  }

  private sagaStepsMapsFromPlanPhases(
    latestPlanByPhaseByDevice: Map<
      string,
      Map<string, { createdAt: number; steps: z.infer<typeof rawPlanStepSchema>[] }>
    >,
  ): Map<string, SagaStep[]> {
    const stepsByDeviceId = new Map<string, SagaStep[]>();
    for (const [deviceId, latestPlanByPhase] of latestPlanByPhaseByDevice) {
      const steps: SagaStep[] = [];
      for (const [phase, { steps: planSteps }] of latestPlanByPhase) {
        for (const step of planSteps) {
          steps.push({
            name: step.step_name,
            operation: step.operation,
            status: step.status,
            phase,
            startedAt: step.started_at ? new Date(step.started_at * 1000).toISOString() : null,
            completedAt: step.completed_at ? new Date(step.completed_at * 1000).toISOString() : null,
            error: step.error ?? null,
          });
        }
      }
      stepsByDeviceId.set(deviceId, steps);
    }
    return stepsByDeviceId;
  }

  async acknowledgeCommissioning(zoneId: string, deviceId: string): Promise<{ success: boolean; message: string }> {
    this.requireCommissioningRole();
    await this.requireCommissioningDevice(zoneId, deviceId);

    await this.prisma.$transaction(async (tx) => {
      const server = await tx.server.findUnique({
        where: { deviceId },
        select: { lifecycleStatus: true },
      });
      if (server?.lifecycleStatus !== ServerLifecycleStatus.INVENTORY) {
        throw new ConflictException(
          `Device ${deviceId} is not qualified (lifecycle: ${server?.lifecycleStatus ?? 'none'}); cannot acknowledge`,
        );
      }

      const claimed = await tx.device.updateMany({
        where: { id: deviceId, role: null, deletedAt: null },
        data: { role: DeviceRole.Server, status: DeviceStatus.ACTIVE },
      });
      if (claimed.count === 0) {
        throw new ConflictException(`Device ${deviceId} was concurrently assigned a role`);
      }
    });

    this.logger.log(`[Commissioning] Device ${deviceId} acknowledged — promoted to Server`);

    try {
      const published = await this.deviceRecordPublisher.writeForDevice(deviceId);
      DeviceRecordPublisher.warnIfPublishSkipped(this.logger, published, 'acknowledge', deviceId);
    } catch (publishErr) {
      this.logger.warn(
        `[Commissioning] device_record publish failed after acknowledge for ${deviceId} (non-fatal): ${getErrorMessage(publishErr)}`,
      );
    }

    return { success: true, message: `Device ${deviceId} promoted to Server` };
  }

  private static readonly RESET_FAILED_STEP_LUA = `
    local raw = redis.call('GET', KEYS[1])
    if not raw then return nil end
    local plan = cjson.decode(raw)
    local steps = plan.steps or {}
    local found = false
    for i, s in ipairs(steps) do
      if s.status == 'failed' then
        s.status = 'pending'
        s.error = cjson.null
        s.started_at = cjson.null
        s.completed_at = cjson.null
        found = true
        break
      end
    end
    if not found then return 0 end
    plan.status = 'pending'
    plan.error = cjson.null
    plan.completed_at = cjson.null
    redis.call('SET', KEYS[1], cjson.encode(plan), 'KEEPTTL')
    return 1
  `;

  async retryCommissioningStep(zoneId: string, deviceId: string): Promise<{ success: boolean; message: string }> {
    this.requireCommissioningRole();
    await this.requireCommissioningDevice(zoneId, deviceId);

    const server = await this.prisma.server.findUnique({ where: { deviceId }, select: { lifecycleStatus: true } });
    if (server?.lifecycleStatus !== ServerLifecycleStatus.FAILED) {
      throw new ConflictException(
        `Device ${deviceId} is not in a failed state (lifecycle: ${server?.lifecycleStatus ?? 'none'}); nothing to retry`,
      );
    }

    const planInfo = await this.findDeviceSagaPlan(zoneId, deviceId);
    if (!planInfo) {
      throw new NotFoundException(
        `No saga plan found for device ${deviceId} in zone ${zoneId} — the plan may have expired from Redis`,
      );
    }

    const key = REDIS_KEYS.sagaPlanById(zoneId, planInfo.planId);
    const evalCmd = this.redis.eval.bind(this.redis);
    const result = await evalCmd(CommissioningService.RESET_FAILED_STEP_LUA, 1, key);
    if (result === null) {
      throw new NotFoundException(`Saga plan ${planInfo.planId} no longer exists in Redis`);
    }
    if (result === 0) {
      throw new ConflictException(`No failed step found in plan ${planInfo.planId} — nothing to reset`);
    }

    if (planInfo.sagaName === 'commission') {
      await resetCommissionJob(this.prisma, planInfo.planId);
    }

    const payload = await this.buildRetryPayload(deviceId, planInfo.sagaName);

    await this.bridgeQueueService.enqueueSagaJob(zoneId, planInfo.sagaName, planInfo.planId, payload, deviceId);

    await this.prisma.server.update({
      where: { deviceId },
      data: { lifecycleStatus: ServerLifecycleStatus.PROVISIONING },
    });

    this.logger.log(
      `[Commissioning] Retry-step: reset failed step in plan ${planInfo.planId} and re-enqueued ${planInfo.sagaName} for device ${deviceId}`,
    );
    return { success: true, message: `Retrying from the failed step for device ${deviceId}` };
  }

  private async findDeviceSagaPlan(
    zoneId: string,
    deviceId: string,
  ): Promise<{ planId: string; sagaName: SagaName } | null> {
    let bestMatch: { planId: string; sagaName: string; createdAt: number } | null = null;

    await this.forEachMatchingSagaPlan(zoneId, deviceId, async (_key, plan) => {
      const hasFailed = (plan.steps ?? []).some((s) => s.status === 'failed');
      if (!hasFailed) return;

      const createdAt = Number(plan.created_at ?? 0);
      if (bestMatch && createdAt <= bestMatch.createdAt) return;

      const sagaName = String(
        plan.job_class ?? (plan.metadata as Record<string, unknown> | undefined)?.saga_name ?? '',
      );
      if (!sagaName) return;

      const planId = plan.plan_id ?? deviceId;
      bestMatch = { planId, sagaName, createdAt };
    });

    if (!bestMatch) return null;

    const validatedData = sagaJobDataSchema.pick({ saga_name: true }).safeParse({ saga_name: bestMatch.sagaName });
    if (!validatedData.success) {
      this.logger.warn(
        `[Commissioning] Retry-step: plan for device ${deviceId} has unrecognized saga_name '${bestMatch.sagaName}'`,
      );
      return null;
    }

    return { planId: bestMatch.planId, sagaName: validatedData.data.saga_name };
  }

  private async buildRetryPayload(deviceId: string, sagaName: SagaName): Promise<Record<string, unknown>> {
    const ctx = await this.deviceContextService.resolve(deviceId);
    const bmcIp = extractBmcIp(ctx.bmcIp) ?? ctx.bmcIp;
    return {
      device_id: ctx.device.id,
      bmc_ip: bmcIp,
      ...bmcSecretDispatchFields(ctx.bmcSecret),
      boot_device: ctx.device.ipmiBootDeviceOverride ?? 'pxe',
      ...(sagaName === 'commission' ? { storage_layouts: {} } : {}),
    };
  }

  async retryCommissioning(
    zoneId: string,
    deviceId: string,
    device: CommissioningDeviceInput,
  ): Promise<{ success: boolean; message: string }> {
    this.requireCommissioningRole();
    await this.requireCommissioningDevice(zoneId, deviceId);

    const server = await this.prisma.server.findUnique({ where: { deviceId }, select: { lifecycleStatus: true } });
    if (server?.lifecycleStatus !== ServerLifecycleStatus.FAILED) {
      throw new ConflictException(
        `Device ${deviceId} is not in a failed state (lifecycle: ${server?.lifecycleStatus ?? 'none'}); nothing to retry`,
      );
    }

    await this.removeBridgeJob(zoneId, deviceId);
    await this.cancelRedisSagaPlans(zoneId, deviceId);

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Device" WHERE id = ${deviceId} AND "deletedAt" IS NULL FOR UPDATE`;
      const locked = await tx.server.findUnique({ where: { deviceId }, select: { lifecycleStatus: true } });
      if (locked?.lifecycleStatus !== ServerLifecycleStatus.FAILED) {
        throw new ConflictException(`Device ${deviceId} retry already in progress`);
      }
      await resetCommissionJob(tx, deviceId);
      await tx.deployment.updateMany({
        where: { server: { deviceId }, endDate: null },
        data: { endDate: new Date() },
      });
      await tx.device.update({ where: { id: deviceId }, data: { status: DeviceStatus.PLANNED } });
      await tx.server.update({ where: { deviceId }, data: { lifecycleStatus: ServerLifecycleStatus.INVENTORY } });
    });

    try {
      const published = await this.deviceRecordPublisher.writeForDevice(deviceId);
      DeviceRecordPublisher.warnIfPublishSkipped(this.logger, published, 'commission-retry', deviceId);
    } catch (publishErr) {
      this.logger.warn(
        `[Commissioning] device_record publish failed for ${deviceId} on retry ` +
          `(non-fatal; render-on-miss backstop): ${getErrorMessage(publishErr)}`,
      );
    }
    const deviceContext = device.bmcIp ? { bmcIp: device.bmcIp } : undefined;
    await this.bridgeCommissioningService.commissionDevice(deviceId, deviceId, {}, zoneId, deviceContext);
    this.logger.log(`[Commissioning] Retry re-enqueued commission saga for device ${deviceId} (row reused)`);

    return { success: true, message: 'Commissioning retry started' };
  }

  async cancelCommissioning(zoneId: string, deviceId: string): Promise<{ success: boolean; message: string }> {
    this.requireCommissioningRole();
    await this.requireCommissioningDevice(zoneId, deviceId);

    const server = await this.prisma.server.findUnique({ where: { deviceId }, select: { lifecycleStatus: true } });
    if (server?.lifecycleStatus === ServerLifecycleStatus.INVENTORY) {
      throw new ConflictException(
        `Device ${deviceId} has completed qualification (awaiting acknowledge); cancelling would discard it. ` +
          `Acknowledge or deprovision it instead.`,
      );
    }

    await this.removeBridgeJob(zoneId, deviceId);
    await this.cancelRedisSagaPlans(zoneId, deviceId);
    await this.softDeleteCommissioningDevice(deviceId);

    this.logger.log(`[Commissioning] Cancelled commissioning for device=${deviceId}`);
    return { success: true, message: 'Commissioning cancelled' };
  }

  private async softDeleteCommissioningDevice(deviceId: string, jobError = 'Commissioning discarded'): Promise<void> {
    const now = new Date();
    const deleted = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.device.updateMany({
        where: { id: deviceId, deletedAt: null },
        data: { deletedAt: now },
      });
      if (count === 0) return false;
      await settleCommissionJob(tx, deviceId, JobStatus.Failed, { error: jobError });
      await softDeleteDeviceNetworkAndSecrets(
        tx,
        this.deviceSecretService,
        deviceId,
        { type: DeviceSecretActorType.USER, id: this.contextService.userId },
        'DEVICE_SOFT_DELETED',
        now,
      );
      return true;
    });

    if (!deleted) {
      this.logger.log(`[Commissioning] Device ${deviceId} already soft-deleted; nothing to tear down`);
      return;
    }

    this.eventEmitter.emit(DeviceLifecycleEvent.SoftDeleted, { deviceId });
    this.logger.log(`[Commissioning] Soft-deleted commissioning device ${deviceId} (+ interfaces + IPs)`);
  }

  private async removeBridgeJob(zoneId: string, deviceId: string): Promise<void> {
    await this.sweepBridgeQueue(this.bridgeQueueService.getLifecycleQueue(zoneId), deviceId, (data) =>
      isRecord(data) && 'device_id' in data ? data.device_id === deviceId : false,
    );
  }

  // Enrich has no Device row — cancel sweeps both lifecycle and collection queues by planId.
  // collection.run lands on the collection queue, which removeBridgeJob never sweeps.
  private async cancelEnrichBridgeJobs(zoneId: string, planId: string): Promise<void> {
    const matchesPlan = (data: unknown): boolean => {
      if (!isRecord(data)) return false;
      return data.device_id === planId || data.plan_id === planId || data.job_id === planId;
    };
    await this.sweepBridgeQueue(this.bridgeQueueService.getLifecycleQueue(zoneId), planId, matchesPlan);
    await this.sweepBridgeQueue(this.bridgeQueueService.getCollectionQueue(zoneId), planId, matchesPlan);
  }

  private async sweepBridgeQueue(
    queue: SweepableQueue,
    label: string,
    matches: (data: unknown) => boolean,
  ): Promise<void> {
    try {
      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      for (const job of jobs) {
        if (!matches(job.data)) continue;

        const state = await job.getState();
        if (state === 'active') {
          await job.discard();
          this.logger.warn(
            `[Commissioning] BullMQ job ${job.id} for ${label} is ACTIVE — cannot remove; discarded (no retry)`,
          );
          continue;
        }

        await job.remove();
        this.logger.log(`[Commissioning] Removed BullMQ job ${job.id} for ${label}`);
      }
    } catch (error) {
      this.logger.warn(`[Commissioning] Failed to remove BullMQ job for ${label}: ${getErrorMessage(error)}`);
    }
  }

  private async forEachMatchingSagaPlan(
    zoneId: string,
    deviceId: string,
    fn: (key: string, plan: RawPlan) => Promise<void>,
  ): Promise<void> {
    for (const key of await scanKeys(this.redis, REDIS_KEYS.sagaPlan(zoneId))) {
      const raw = await this.redis.get(key);
      if (!raw) continue;
      const parsed = rawPlanSchema.safeParse(JSON.parse(raw));
      if (!parsed.success || !this.planMatchesDevice(parsed.data, deviceId)) continue;
      await fn(key, parsed.data);
    }
  }

  private async clearRedisSagaPlans(zoneId: string, deviceId: string): Promise<void> {
    try {
      let deleted = 0;
      await this.forEachMatchingSagaPlan(zoneId, deviceId, async (key) => {
        await this.redis.del(key);
        deleted++;
      });
      if (deleted > 0) this.logger.log(`[Commissioning] Cleared ${deleted} stale saga plans for device ${deviceId}`);
    } catch (error) {
      this.logger.warn(`[Commissioning] Failed to clear old saga plans for retry: ${getErrorMessage(error)}`);
    }
  }

  private async cancelRedisSagaPlans(zoneId: string, deviceId: string): Promise<void> {
    try {
      let cancelled = 0;
      await this.forEachMatchingSagaPlan(zoneId, deviceId, async (key, plan) => {
        if (['complete', 'failed', 'cancelled'].includes(String(plan.status))) return;
        plan.status = 'cancelled';
        plan.completed_at = Date.now() / 1000;
        // KEEPTTL: a bare SET would clear the bridge-set expiry and leak the key forever.
        await this.redis.set(key, JSON.stringify(plan), 'KEEPTTL');
        cancelled++;
      });
      if (cancelled > 0)
        this.logger.log(`[Commissioning] Cancelled ${cancelled} Redis saga plans for device ${deviceId}`);
    } catch (error) {
      this.logger.warn(
        `[Commissioning] Failed to cancel Redis saga plans for device ${deviceId}: ${getErrorMessage(error)}`,
      );
    }
  }

  private async composeAddressWithPrefixMask(
    tx: Prisma.TransactionClient,
    ip: string,
    zoneId: string,
  ): Promise<string> {
    const host = ip.includes('/') ? ip.split('/')[0] : ip;
    const rows = await tx.$queryRaw<Array<{ masklen: number }>>(Prisma.sql`
      SELECT masklen(p.prefix) AS masklen
      FROM "Prefix" p
      WHERE p."zoneId" = ${zoneId}
        AND p."deletedAt" IS NULL
        AND ${host}::inet << p.prefix
      ORDER BY masklen(p.prefix) DESC
      LIMIT 1
    `);
    const masklen = rows[0]?.masklen;
    return masklen != null ? `${host}/${Number(masklen)}` : host;
  }
}
