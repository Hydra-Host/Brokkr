import { createHash } from 'node:crypto';
import { getErrorMessage } from '../../common/error-utils';

import { Injectable } from '@nestjs/common';

import { getLogger } from '../../logger/logger.service';
import { AgentNotConnected, AgentVersionMismatch, DispatchFailed, DispatchTimeout } from '../dispatch/grpc.exceptions';

import { buildUpgradePayload, type UpgradePayload } from './upgrade-payload';

const LOCK_TTL_S = 300;
const COOLDOWN_TTL_S = 300;
const DISPATCH_TIMEOUT_S = 120.0;
const RENDER_TIMEOUT_S = 30.0;
const CONFIG_CACHE_TTL_S = 600;

export class AgentUpgradeRateLimited extends Error {
  readonly deviceId: string;

  constructor(deviceId: string) {
    super(`device ${deviceId} in upgrade cooldown`);
    this.name = 'AgentUpgradeRateLimited';
    this.deviceId = deviceId;
  }
}

export interface AgentUpgradeCachePort {
  exists(key: string, jobId?: string): Promise<boolean>;
  set(key: string, value: string, ttl?: number, jobId?: string): Promise<unknown>;
  secretSet(key: string, value: string, ttl?: number, jobId?: string): Promise<unknown>;
  acquireLock(lockKey: string, timeout?: number, jobId?: string): Promise<string | null>;
  releaseLock(lockKey: string, token: string, jobId?: string): Promise<boolean>;
}

export interface UpgradeDispatchOptions {
  jobId?: string | null;
  timeoutS?: number | null;
}

export type UpgradeDispatchFn = (
  deviceId: string,
  operation: string,
  input: unknown,
  options?: UpgradeDispatchOptions,
) => Promise<unknown>;

export interface UpgradeDeviceServicePort {
  getDeviceById(deviceId: string): Promise<unknown>;
}

export interface UpgradeTokenServicePort {
  mintOrReuseDevice(deviceId: string, jobId?: string): Promise<string>;
}

export interface UpgradeBridgeRegistryPort {
  getAllBridgeHostnames(jobId: string): Promise<readonly string[]>;
}

export interface UpgradeGrpcConfigPort {
  readonly externalPort: number;
}

export interface RenderAgentYamlParams {
  deviceId: string;
  bridges: readonly string[];
  agentToken: string;
  jobId: string;
}

export type RenderAgentYamlFn = (params: RenderAgentYamlParams) => Promise<string>;

export interface UpgradeLogger {
  info(message: string, context?: { jobId?: string | null }): void | Promise<void>;
  warning(message: string, context?: { jobId?: string | null }): void | Promise<void>;
}

const FORWARDING_LOGGER: UpgradeLogger = {
  info: (msg, ctx) => getLogger().info(msg, { jobId: ctx?.jobId ?? undefined }),
  warning: (msg, ctx) => getLogger().warning(msg, { jobId: ctx?.jobId ?? undefined }),
};

export interface AgentUpgradeServiceDeps {
  cache: AgentUpgradeCachePort;
  dispatch: UpgradeDispatchFn;
  deviceService: UpgradeDeviceServicePort;
  tokenService: UpgradeTokenServicePort;
  bridgeRegistry: UpgradeBridgeRegistryPort;
  grpcConfig: UpgradeGrpcConfigPort;
  renderAgentYaml: RenderAgentYamlFn;
  bundleSha256: () => Promise<string>;
  unitSha256: () => Promise<string>;
  logger?: UpgradeLogger;
  renderTimeoutS?: number;
}

export interface UpgradeAgentParams {
  deviceId: string;
  currentVersion: string;
  expectedVersion: string;
  jobId: string | null;
}

class RenderTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderTimeoutError';
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutS: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RenderTimeoutError(`timed out after ${timeoutS}s`)), timeoutS * 1000);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    promise.catch(() => undefined);
  }
}

@Injectable()
export class AgentUpgradeService {
  private readonly cache: AgentUpgradeCachePort;
  private readonly dispatch: UpgradeDispatchFn;
  private readonly deviceService: UpgradeDeviceServicePort;
  private readonly tokenService: UpgradeTokenServicePort;
  private readonly bridgeRegistry: UpgradeBridgeRegistryPort;
  private readonly grpcConfig: UpgradeGrpcConfigPort;
  private readonly renderAgentYaml: RenderAgentYamlFn;
  private readonly bundleSha256: () => Promise<string>;
  private readonly unitSha256: () => Promise<string>;
  private readonly logger: UpgradeLogger;
  private readonly renderTimeoutS: number;

  constructor(deps: AgentUpgradeServiceDeps) {
    this.cache = deps.cache;
    this.dispatch = deps.dispatch;
    this.deviceService = deps.deviceService;
    this.tokenService = deps.tokenService;
    this.bridgeRegistry = deps.bridgeRegistry;
    this.grpcConfig = deps.grpcConfig;
    this.renderAgentYaml = deps.renderAgentYaml;
    this.bundleSha256 = deps.bundleSha256;
    this.unitSha256 = deps.unitSha256;
    this.logger = deps.logger ?? FORWARDING_LOGGER;
    this.renderTimeoutS = deps.renderTimeoutS ?? RENDER_TIMEOUT_S;
  }

  private async renderAndCacheAgentYaml(deviceId: string, jobId: string | null): Promise<string | null> {
    const logJobId = jobId ?? '';
    try {
      await this.deviceService.getDeviceById(deviceId);
    } catch (error) {
      await this.logger.warning(
        `agent upgrade: device lookup failed for config render device_id=${deviceId}: ${getErrorMessage(error)}`,
        { jobId },
      );
      return null;
    }

    let rendered: string;
    try {
      const hostnames = await this.bridgeRegistry.getAllBridgeHostnames(logJobId);
      const port = this.grpcConfig.externalPort;
      const bridges = hostnames.map((h) => `${h}:${port}`);
      const agentToken = await this.tokenService.mintOrReuseDevice(deviceId, logJobId);
      rendered = await this.renderAgentYaml({
        deviceId,
        bridges,
        agentToken,
        jobId: logJobId,
      });
    } catch (error) {
      await this.logger.warning(`agent upgrade: render failed device_id=${deviceId}: ${getErrorMessage(error)}`, {
        jobId,
      });
      return null;
    }

    const configSha = createHash('sha256').update(rendered, 'utf8').digest('hex');
    try {
      await this.cache.secretSet(`agent-config-cache:${configSha}`, rendered, CONFIG_CACHE_TTL_S, logJobId);
    } catch (error) {
      await this.logger.warning(
        `agent upgrade: failed to cache rendered config device_id=${deviceId}: ${getErrorMessage(error)}`,
        { jobId },
      );
      return null;
    }

    await this.logger.info(
      `agent upgrade: cached fresh agent.yaml device_id=${deviceId} config_sha=${configSha.slice(0, 12)}... bytes=${rendered.length} ttl_s=${CONFIG_CACHE_TTL_S}`,
      { jobId },
    );
    return configSha;
  }

  async upgradeAgent(params: UpgradeAgentParams): Promise<boolean> {
    const { deviceId, currentVersion, expectedVersion } = params;
    const jobId = params.jobId;
    const logJobId = jobId ?? '';
    const lockKey = `agent-upgrade:${deviceId}`;

    if (currentVersion === expectedVersion) {
      await this.logger.info(`agent upgrade: skip identity dispatch device_id=${deviceId} version=${currentVersion}`, {
        jobId,
      });
      return false;
    }

    const sagaLockKey = `device:${deviceId}`;
    if (await this.cache.exists(sagaLockKey, logJobId)) {
      await this.logger.info(`agent upgrade: device ${deviceId} has active saga lock, deferring`, { jobId });
      return false;
    }

    const token = await this.cache.acquireLock(lockKey, LOCK_TTL_S, logJobId);
    if (token === null) {
      await this.logger.info(
        `agent upgrade: lock already held device_id=${deviceId} current=${currentVersion} expected=${expectedVersion}`,
        { jobId },
      );
      return false;
    }

    try {
      const cooldownKey = `agent-upgrade:cooldown:${deviceId}`;
      if (await this.cache.exists(cooldownKey, logJobId)) {
        throw new AgentUpgradeRateLimited(deviceId);
      }

      const sha = await this.bundleSha256();
      const unitSha = await this.unitSha256();

      await this.logger.info(
        `agent upgrade: dispatching bundle device_id=${deviceId} from=${currentVersion} to=${expectedVersion}`,
        { jobId },
      );

      let configSha: string | null;
      try {
        configSha = await withTimeout(this.renderAndCacheAgentYaml(deviceId, jobId), this.renderTimeoutS);
      } catch (error) {
        if (error instanceof RenderTimeoutError) {
          await this.logger.warning(
            `agent upgrade: agent.yaml render exceeded ${this.renderTimeoutS}s device_id=${deviceId}; dispatching bundle without config refresh`,
            { jobId },
          );
          configSha = null;
        } else {
          throw error;
        }
      }

      const payload: UpgradePayload = buildUpgradePayload({
        sha,
        expectedVersion,
        unitSha,
        configSha,
      });

      try {
        await this.dispatch(deviceId, 'agent.upgrade', payload, {
          jobId,
          timeoutS: DISPATCH_TIMEOUT_S,
        });
      } catch (error) {
        if (error instanceof DispatchFailed) {
          await this.logger.warning(
            `agent upgrade: dispatch failed device_id=${deviceId} code=${error.code} current=${currentVersion} expected=${expectedVersion}`,
            { jobId },
          );
          return false;
        }
        if (error instanceof AgentVersionMismatch) {
          await this.logger.warning(
            `agent upgrade: dispatch surfaced AgentVersionMismatch (dispatcher gate bypass regressed?) device_id=${deviceId} current=${error.actual} expected=${error.expected}`,
            { jobId },
          );
          return false;
        }
        if (error instanceof AgentNotConnected) {
          await this.logger.info(
            `agent upgrade: no live session at dispatch time device_id=${deviceId} from=${currentVersion} to=${expectedVersion}`,
            { jobId },
          );
        } else if (error instanceof DispatchTimeout) {
          await this.logger.info(
            `agent upgrade: no work response within ${DISPATCH_TIMEOUT_S}s device_id=${deviceId} from=${currentVersion} to=${expectedVersion} (agent may have restarted, session may have churned, or work request was lost)`,
            { jobId },
          );
        } else {
          throw error;
        }
      }

      await this.cache.set(cooldownKey, '1', COOLDOWN_TTL_S, logJobId);
      return true;
    } finally {
      await this.cache.releaseLock(lockKey, token, logJobId);
    }
  }
}
