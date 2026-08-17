import https from 'node:https';
import { getBullmqConfig } from '../../bullmq/bullmq.config';
import { sealOutboundPayload, type SealedEnvelope, type ZoneCryptoState } from '../../bullmq/seal-outbound-payload';
import { getErrorMessage } from '../../common/error-utils';
import type { RedisClient } from '../../common/redis/redis-client';
import { NIL_DEVICE_ID, deviceHealth } from '../../common/redis/redis-keys';
import { logDebug, logError, logInfo, logWarning } from '../../logger/logger.service';
import { getCipherForDevice } from '../../oob/ipmi/cipher';
import { createIpmiDevice, withCipher, type IPMIDevice } from '../../oob/ipmi/device';
import { power } from '../../oob/ipmi/handlers/power';
import { ipmiPing } from '../../oob/ipmi/ping';
import {
  isTlsCertVerificationError,
  redfishRejectUnauthorized,
  redfishTlsVerificationFailureHint,
  warnRedfishTlsVerificationDisabledOnce,
} from '../../redfish/redfish.config.js';
import { getActiveZoneCryptoSnapshot } from '../../zone-crypto/zone-crypto.service';

export const RESULT_TTL_SECONDS = 600;

let warnedTlsVerificationFailure = false;
function warnRedfishTlsVerificationFailureOnce(host: string): void {
  if (warnedTlsVerificationFailure) return;
  warnedTlsVerificationFailure = true;
  void logWarning(redfishTlsVerificationFailureHint(host));
}

export const HEALTH_FIELDS = [
  'primary_reachable',
  'bmc_icmp_reachable',
  'bmc_ipmi_reachable',
  'bmc_redfish_reachable',
  'bmc_creds_valid',
  'powered_on',
  'brokkr_live_running',
] as const;

export type HealthField = (typeof HEALTH_FIELDS)[number];

export interface HealthCheckResult {
  device_id: string;
  primary_reachable: boolean | null;
  bmc_icmp_reachable: boolean | null;
  bmc_ipmi_reachable: boolean | null;
  bmc_redfish_reachable: boolean | null;
  bmc_creds_valid: boolean | null;
  powered_on: boolean | null;
  brokkr_live_running: boolean | null;
  checked_at: number;
}

export interface IcmpPingService {
  executePingTest(args: { ip: string; count: number; timeout: number }): Promise<
    {
      metrics?: { icmpping?: number } & Record<string, unknown>;
    } & Record<string, unknown>
  >;
}

export interface IcmpServiceFactory {
  create(jobId: string): IcmpPingService;
}

export interface BrokkrLiveConnectivity {
  testDeviceConnectivity(deviceId: string): Promise<{ connected: boolean }>;
}

export interface BrokkrLiveServiceFactory {
  create(jobId: string): Promise<BrokkrLiveConnectivity>;
}

export interface ResultsRedisProvider {
  get(): Promise<RedisClient>;
}

export interface ResultsQueueLike {
  add(name: string, payload: Record<string, unknown> | SealedEnvelope, opts: Record<string, unknown>): Promise<unknown>;
}

export interface ResultsQueueProvider {
  get(): Promise<ResultsQueueLike | null>;
}

export interface JobStorageConfigProvider {
  getBullmqPrefix(): string;
}

export interface DeviceHealthDeps {
  icmpFactory: IcmpServiceFactory;
  brokkrLiveFactory: BrokkrLiveServiceFactory;
  resultsRedis: ResultsRedisProvider;
  resultsQueue: ResultsQueueProvider;
  jobStorage: JobStorageConfigProvider;
}

export interface CheckDeviceHealthArgs {
  deviceId: string;
  bmcIp?: string | null;
  primaryIp?: string | null;
  username?: string;
  password?: string;
}

function now(): number {
  return Date.now() / 1000;
}

interface IpmiCredsCheckOutcome {
  creds_valid: boolean | null;
  power_on: boolean | null;
}

export class DeviceHealthService {
  constructor(
    private readonly jobId: string,
    private readonly deps: DeviceHealthDeps,
  ) {}

  async checkDeviceHealth(args: CheckDeviceHealthArgs): Promise<HealthCheckResult> {
    const deviceId = args.deviceId;
    const bmcIp = args.bmcIp ?? null;
    const primaryIp = args.primaryIp ?? null;
    const username = args.username ?? '';
    const password = args.password ?? '';

    const checks: Array<readonly [string, Promise<unknown>]> = [];

    if (primaryIp) {
      checks.push(['primary_reachable', this.checkPing(primaryIp)]);
    }

    if (bmcIp) {
      checks.push(['bmc_icmp_reachable', this.checkPing(bmcIp)]);
      checks.push(['bmc_ipmi_reachable', this.checkIpmiPing(bmcIp)]);
      checks.push(['bmc_redfish_reachable', this.checkRedfishPing(bmcIp)]);
    }

    if (bmcIp && username && password) {
      checks.push(['ipmi_creds_power', this.checkIpmiCreds(bmcIp, username, password, deviceId)]);
    }

    checks.push(['brokkr_live', this.checkBrokkrLive(deviceId)]);

    const result: HealthCheckResult = {
      device_id: deviceId,
      primary_reachable: null,
      bmc_icmp_reachable: null,
      bmc_ipmi_reachable: null,
      bmc_redfish_reachable: null,
      bmc_creds_valid: null,
      powered_on: null,
      brokkr_live_running: null,
      checked_at: now(),
    };

    if (checks.length > 0) {
      const settled = await Promise.all(
        checks.map(async ([name, promise]) => {
          try {
            return { name, value: await promise, ok: true as const };
          } catch (error) {
            return { name, error, ok: false as const };
          }
        }),
      );

      for (const entry of settled) {
        if (!entry.ok) {
          await logDebug(`Device ${deviceId} check '${entry.name}' failed: ${getErrorMessage(entry.error)}`, {
            jobId: this.jobId,
          });
          continue;
        }

        const { name, value } = entry;
        if (name === 'primary_reachable') {
          result.primary_reachable = value as boolean;
        } else if (name === 'bmc_icmp_reachable') {
          result.bmc_icmp_reachable = value as boolean;
        } else if (name === 'bmc_ipmi_reachable') {
          result.bmc_ipmi_reachable = value as boolean;
        } else if (name === 'bmc_redfish_reachable') {
          result.bmc_redfish_reachable = value as boolean;
        } else if (name === 'ipmi_creds_power') {
          const outcome = value as IpmiCredsCheckOutcome;
          result.bmc_creds_valid = outcome.creds_valid ?? null;
          result.powered_on = outcome.power_on ?? null;
        } else if (name === 'brokkr_live') {
          result.brokkr_live_running = value as boolean;
        }
      }
    }

    await logInfo(
      `Device ${deviceId} health: primary=${result.primary_reachable} ` +
        `bmc_icmp=${result.bmc_icmp_reachable} bmc_ipmi=${result.bmc_ipmi_reachable} ` +
        `bmc_redfish=${result.bmc_redfish_reachable} creds=${result.bmc_creds_valid} ` +
        `power=${result.powered_on} live=${result.brokkr_live_running}`,
      { jobId: this.jobId },
    );

    await this.persistAndNotify(deviceId, result);

    return result;
  }

  static healthChanged(previous: Record<string, unknown> | null, current: Record<string, unknown>): boolean {
    if (previous === null) return true;
    return HEALTH_FIELDS.some((f) => previous[f] !== current[f]);
  }

  private async persistAndNotify(deviceId: string, result: HealthCheckResult): Promise<void> {
    try {
      const zonePrefix = this.deps.jobStorage.getBullmqPrefix();
      const redisKey = deviceHealth(deviceId);
      const redis = await this.deps.resultsRedis.get();

      const previousRaw = await redis.get(redisKey);
      const previous = previousRaw ? (JSON.parse(previousRaw) as Record<string, unknown>) : null;

      // Notify BEFORE persisting: if the enqueue throws, the stale snapshot keeps the diff detectable next check (persist-first would mask the change forever); re-sends are harmless — device_health is idempotent on the hub.
      if (DeviceHealthService.healthChanged(previous, result as unknown as Record<string, unknown>)) {
        await this.sendStateChange(zonePrefix, deviceId, result);
      } else {
        await logDebug(`Device ${deviceId} health unchanged, skipping hub notification`, {
          jobId: this.jobId,
        });
      }

      await redis.set(redisKey, JSON.stringify(result), RESULT_TTL_SECONDS);
    } catch (error) {
      await logError(`Failed to store/diff health result for device ${deviceId}: ${getErrorMessage(error)}`, {
        jobId: this.jobId,
      });
    }
  }

  private async sendStateChange(zonePrefix: string, deviceId: string, result: HealthCheckResult): Promise<void> {
    const queue = await this.deps.resultsQueue.get();
    if (queue === null) return;

    const payload: Record<string, unknown> = {
      zone_prefix: zonePrefix,
      device_id: deviceId,
      job_id: this.jobId,
    };
    for (const [k, v] of Object.entries(result)) {
      if (k === 'checked_at') continue;
      payload[k] = v;
    }

    await queue.add('device_health', this.sealForHub(payload, zonePrefix), {
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 100 },
    });

    await logInfo(`Device ${deviceId} health state changed, notified hub`, {
      jobId: this.jobId,
    });
  }

  private sealForHub(payload: Record<string, unknown>, zoneId: string): Record<string, unknown> | SealedEnvelope {
    const snapshot = getActiveZoneCryptoSnapshot();
    if (snapshot === null) return payload;
    const zoneCrypto: ZoneCryptoState = { zonePriv: snapshot.zonePriv, hubPub: snapshot.hubPub, zoneId };
    return sealOutboundPayload(payload, {
      queueName: getBullmqConfig().resultsQueueName,
      aadJobId: this.jobId,
      zoneCrypto,
    });
  }

  private async checkPing(ip: string): Promise<boolean> {
    try {
      const service = this.deps.icmpFactory.create(this.jobId);
      const result = await service.executePingTest({ ip, count: 1, timeout: 3 });
      const metrics = result.metrics ?? {};
      return (metrics.icmpping ?? 0) === 1;
    } catch {
      return false;
    }
  }

  private async checkIpmiPing(bmcIp: string): Promise<boolean> {
    try {
      return await ipmiPing(bmcIp, { port: 623, timeout: 3, jobId: this.jobId });
    } catch {
      return false;
    }
  }

  private async checkRedfishPing(bmcIp: string): Promise<boolean> {
    const MAX_REDIRECTS = 10;
    const TOTAL_TIMEOUT_MS = 3000;
    const deadline = Date.now() + TOTAL_TIMEOUT_MS;
    const rejectUnauthorized = redfishRejectUnauthorized();
    if (!rejectUnauthorized) warnRedfishTlsVerificationDisabledOnce((m) => void logWarning(m), bmcIp);

    const requestOnce = (url: URL, remainingMs: number): Promise<{ status: number; location: string | null }> =>
      new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          fn();
        };
        try {
          const req = https.request(
            {
              host: url.hostname,
              port: url.port ? Number(url.port) : 443,
              path: `${url.pathname}${url.search}`,
              method: 'GET',
              timeout: remainingMs,
              rejectUnauthorized,
            },
            (res) => {
              const status = res.statusCode ?? 0;
              const location = (res.headers.location ?? null) as string | null;
              res.resume();
              settle(() => resolve({ status, location }));
            },
          );
          req.on('timeout', () => {
            req.destroy();
            settle(() => reject(new Error('timeout')));
          });
          req.on('error', (err) => {
            if (rejectUnauthorized && isTlsCertVerificationError(err)) warnRedfishTlsVerificationFailureOnce(url.host);
            settle(() => reject(err));
          });
          req.end();
        } catch (err) {
          settle(() => reject(err instanceof Error ? err : new Error(String(err))));
        }
      });

    try {
      let url = new URL(`https://${bmcIp}/redfish/v1/`);
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;
        const { status, location } = await requestOnce(url, remaining);
        if (
          (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) &&
          location !== null &&
          hop < MAX_REDIRECTS
        ) {
          url = new URL(location, url);
          continue;
        }
        return status === 200 || status === 401;
      }
      return false;
    } catch {
      return false;
    }
  }

  private async checkIpmiCreds(
    bmcIp: string,
    username: string,
    password: string,
    deviceId: string,
  ): Promise<IpmiCredsCheckOutcome> {
    const outcome: IpmiCredsCheckOutcome = { creds_valid: null, power_on: null };

    try {
      let device: IPMIDevice = createIpmiDevice({ ip: bmcIp, username, password, jobId: this.jobId });
      const redis = await this.deps.resultsRedis.get();
      const cipher = await getCipherForDevice(redis, device, deviceId);
      device = withCipher(device, cipher);

      const ipmiResult = await power(device, 'status');

      if (ipmiResult.ok) {
        outcome.creds_valid = true;
        const response = ipmiResult.stdout;
        outcome.power_on = response.includes('Chassis Power') ? response.toLowerCase().includes('on') : false;
      } else {
        outcome.creds_valid = false;
      }
    } catch (error) {
      await logDebug(`IPMI creds check failed for device ${deviceId}: ${getErrorMessage(error)}`, {
        jobId: this.jobId,
      });
    }

    return outcome;
  }

  private async checkBrokkrLive(deviceId: string): Promise<boolean> {
    if (!deviceId || deviceId === NIL_DEVICE_ID) return false;

    try {
      const service = await this.deps.brokkrLiveFactory.create(this.jobId);
      const result = await withTimeout(service.testDeviceConnectivity(deviceId), 5000);
      return result.connected;
    } catch {
      return false;
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export async function createDeviceHealthService(jobId: string, deps: DeviceHealthDeps): Promise<DeviceHealthService> {
  return new DeviceHealthService(jobId, deps);
}
