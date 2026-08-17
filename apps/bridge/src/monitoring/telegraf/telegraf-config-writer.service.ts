import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getErrorMessage } from '../../common/error-utils';

import { extractBmcIp } from '../common/active-devices.service';
import type { OwnedDevice, RenderConfig } from './telegraf-config-renderer.service';
import { KIND_PDU, KIND_SERVER, renderOwnedDevicesConf } from './telegraf-config-renderer.service';
import type {
  ActiveDevicesPort,
  BmcCredentialsLookupPort,
  BridgePartitionerPort,
  InfraTargetsPort,
  PduVendorClassifierPort,
  TelegrafConfigWriterLogger,
} from './telegraf-config-writer.types';

export const APP_CLASS_NAME = 'telegraf-config-writer';

const DEFAULT_DEBOUNCE_SECONDS = 30.0;
const DEFAULT_POLL_INTERVAL_SECONDS = 10.0;
const DEFAULT_FILE_MODE = 0o600;
const DEFAULT_TARGET_REFRESH_SECONDS = 300.0;

export interface TelegrafConfigWriterConfig {
  readonly outputPath: string;
  readonly renderConfig: RenderConfig;
  readonly debounceSeconds?: number;
  readonly pollIntervalSeconds?: number;
  readonly fileMode?: number;
  readonly targetRefreshSeconds?: number;
}

interface ResolvedTarget {
  readonly kind: string;
  readonly bmcIp: string;
  readonly pduProfile: string | null;
}

interface CachedTarget {
  readonly target: ResolvedTarget;
  readonly resolvedAt: number;
}

@Injectable()
export class TelegrafConfigWriterService {
  private readonly debounceSeconds: number;
  private readonly pollIntervalSeconds: number;
  private readonly fileMode: number;

  private lastWrittenHash: string | null = null;
  private lastSeenHash: string | null = null;
  private stableSince: number | null = null;
  private firstWriteDone = false;
  private running = false;

  private readonly targetCache = new Map<string, CachedTarget>();
  private readonly warnedNoScrapeTarget = new Set<string>();
  private readonly targetRefreshSeconds: number;

  constructor(
    private readonly partitioner: BridgePartitionerPort,
    private readonly credsLookup: BmcCredentialsLookupPort,
    private readonly activeDevices: ActiveDevicesPort,
    private readonly infraTargets: InfraTargetsPort,
    private readonly pduClassifier: PduVendorClassifierPort,
    private readonly config: TelegrafConfigWriterConfig,
    private readonly logger: TelegrafConfigWriterLogger,
    private readonly jobId: string = '',
  ) {
    this.debounceSeconds = config.debounceSeconds ?? DEFAULT_DEBOUNCE_SECONDS;
    this.pollIntervalSeconds = config.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS;
    this.fileMode = config.fileMode ?? DEFAULT_FILE_MODE;
    this.targetRefreshSeconds = config.targetRefreshSeconds ?? DEFAULT_TARGET_REFRESH_SECONDS;
  }

  async tick(now: number = monotonicSeconds()): Promise<boolean> {
    let devices: OwnedDevice[];
    try {
      devices = await this.computeOwnedDevices(now);
    } catch (error) {
      await this.logger.warning(`compute owned devices failed: ${getErrorMessage(error)}`, {
        appClassName: APP_CLASS_NAME,
        jobId: this.jobId,
      });
      return false;
    }

    const content = renderOwnedDevicesConf(devices, this.config.renderConfig);
    const currentHash = createHash('sha256').update(content, 'utf8').digest('hex');

    if (!this.firstWriteDone) {
      await this.writeAndRecord(content, currentHash, now);
      this.firstWriteDone = true;
      await this.logger.info(
        `wrote initial telegraf config: ${devices.length} owned devices, hash=${currentHash.slice(0, 8)}`,
        { appClassName: APP_CLASS_NAME, jobId: this.jobId },
      );
      return true;
    }

    if (currentHash !== this.lastSeenHash) {
      this.lastSeenHash = currentHash;
      this.stableSince = now;
    }

    if (
      currentHash !== this.lastWrittenHash &&
      this.stableSince !== null &&
      now - this.stableSince >= this.debounceSeconds
    ) {
      await this.writeAndRecord(content, currentHash, now);
      await this.logger.info(
        `wrote updated telegraf config: ${devices.length} owned devices, hash=${currentHash.slice(0, 8)}`,
        { appClassName: APP_CLASS_NAME, jobId: this.jobId },
      );
      return true;
    }

    return false;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.logger.info(`TelegrafConfigWriter starting; output=${this.config.outputPath}`, {
      appClassName: APP_CLASS_NAME,
      jobId: this.jobId,
    });
    while (this.running) {
      try {
        await this.tick();
      } catch (error) {
        await this.logger.warning(`writer tick failed: ${getErrorMessage(error)}`, {
          appClassName: APP_CLASS_NAME,
          jobId: this.jobId,
        });
      }
      await sleep(this.pollIntervalSeconds * 1000);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  private async writeAndRecord(content: string, contentHash: string, now: number): Promise<void> {
    await this.atomicWrite(content);
    this.lastWrittenHash = contentHash;
    this.lastSeenHash = contentHash;
    this.stableSince = now;
  }

  private async computeOwnedDevices(now: number): Promise<OwnedDevice[]> {
    const currentIds = new Set<string>();
    for await (const deviceId of this.activeDevices.iterActiveDeviceIds(this.jobId)) {
      currentIds.add(deviceId);
    }

    for (const gone of [...this.targetCache.keys()]) {
      if (!currentIds.has(gone)) this.targetCache.delete(gone);
    }
    for (const gone of [...this.warnedNoScrapeTarget]) {
      if (!currentIds.has(gone)) this.warnedNoScrapeTarget.delete(gone);
    }

    const owned: OwnedDevice[] = [];
    for (const deviceId of currentIds) {
      if (!this.partitioner.owns(deviceId)) continue;

      const cached = this.targetCache.get(deviceId);
      let target = cached?.target;
      if (cached === undefined || now - cached.resolvedAt >= this.targetRefreshSeconds) {
        const resolved = await this.resolveTarget(deviceId);
        if (resolved !== null) {
          target = resolved;
          this.targetCache.set(deviceId, { target: resolved, resolvedAt: now });
        } else {
          this.targetCache.delete(deviceId);
          target = undefined;
        }
      }
      if (target === undefined) continue;

      owned.push({
        device_id: deviceId,
        kind: target.kind,
        pdu_profile: target.pduProfile,
        bmc_ip: target.bmcIp,
      });
    }
    return owned;
  }

  // Servers require sealed BMC creds; PDU/CDU need only the mgmt-only IP (SNMP community from telegraf env, CDU creds resolved on demand). Null = no scrape target yet; retried next tick, never cached.
  private async resolveTarget(deviceId: string): Promise<ResolvedTarget | null> {
    const data = await this.activeDevices.getCachedDeviceData(deviceId, this.jobId);
    const kind = this.infraTargets.classifyRole(this.infraTargets.extractRole(data));

    if (kind === KIND_SERVER) {
      const creds = await this.credsLookup.get(deviceId);
      if (creds === null) return null;
      return { kind, bmcIp: creds.bmcIp, pduProfile: null };
    }

    const bmcIp = data === null ? null : extractBmcIp(data);
    if (bmcIp === null) {
      if (!this.warnedNoScrapeTarget.has(deviceId)) {
        this.warnedNoScrapeTarget.add(deviceId);
        await this.logger.warning(`${kind} device ${deviceId}: no mgmt-only IP in device data; skipping`, {
          appClassName: APP_CLASS_NAME,
          jobId: this.jobId,
        });
      }
      return null;
    }
    this.warnedNoScrapeTarget.delete(deviceId);

    if (kind !== KIND_PDU) {
      return { kind, bmcIp, pduProfile: null };
    }
    const pduProfile = this.pduClassifier.classifyPduVendor(data);
    if (pduProfile === null) {
      await this.logger.warning(
        `PDU device ${deviceId}: unrecognized vendor (no SNMP profile); only ICMP will be collected`,
        { appClassName: APP_CLASS_NAME, jobId: this.jobId },
      );
    }
    return { kind, bmcIp, pduProfile };
  }

  private async atomicWrite(content: string): Promise<void> {
    const final = this.config.outputPath;
    const finalDir = dirname(final);
    const finalName = basename(final);
    await mkdir(finalDir, { recursive: true, mode: 0o700 });

    const tmpPath = `${finalDir}/.${finalName}.${randomBytes(8).toString('hex')}.tmp`;
    let renamed = false;
    try {
      const handle = await open(tmpPath, 'w', this.fileMode);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(tmpPath, this.fileMode);
      await rename(tmpPath, final);
      renamed = true;
    } finally {
      if (!renamed) {
        try {
          await unlink(tmpPath);
        } catch (error) {
          await this.logger.warning(`telegraf config tmp file cleanup failed: ${getErrorMessage(error)}`, {
            appClassName: APP_CLASS_NAME,
            jobId: this.jobId,
          });
        }
      }
    }
  }
}

function monotonicSeconds(): number {
  return performance.now() / 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}
