import { Injectable } from '@nestjs/common';

import { deviceLanChannel } from '../../common/redis/redis-keys';
import { getLogger } from '../../logger/logger.service';
import { getIpmiConfig } from '../ipmi/ipmi.config.js';
import { validateIp, validateUsername } from '../ipmi/validation.js';

import type { IPMIDevice } from '../ipmi/device.js';
import type { IPMIResult } from '../ipmi/result.js';

export type { IPMIDevice, IPMIResult };

export interface SolProvisioningCache {
  get(key: string, jobId?: string): Promise<string | null>;
  set(key: string, value: string, ttl?: number | null, jobId?: string): Promise<unknown>;
  delete(key: string, jobId?: string): Promise<number>;
}

export type SolProvisioningCipherFn = (device: IPMIDevice, deviceId?: string | null) => Promise<string | null>;

export type SolProvisioningTransportFn = (
  command: readonly string[],
  password: string,
  timeout: number,
  opts: { cipherUsed?: string | null; jobId?: string },
) => Promise<IPMIResult>;

export interface SolProvisioningHandlers {
  solInfo(device: IPMIDevice, channel: number, opts: { timeout?: number }): Promise<IPMIResult>;
  solSetEnabled(device: IPMIDevice, enabled: boolean, channel: number, opts: { timeout?: number }): Promise<IPMIResult>;
  solPayloadStatus(
    device: IPMIDevice,
    channel: number,
    userId: number,
    opts: { timeout?: number },
  ): Promise<IPMIResult>;
  solPayloadEnable(
    device: IPMIDevice,
    channel: number,
    userId: number,
    opts: { timeout?: number },
  ): Promise<IPMIResult>;
}

export interface SolProvisioningLogger {
  info(message: string, context?: { jobId?: string }): void | Promise<void>;
  warning(message: string, context?: { jobId?: string }): void | Promise<void>;
  debug(message: string, context?: { jobId?: string }): void | Promise<void>;
}

export interface SolProvisioningDeps {
  cache: SolProvisioningCache;
  getCipher: SolProvisioningCipherFn;
  transport: SolProvisioningTransportFn;
  handlers: SolProvisioningHandlers;
  buildBaseCommand: (device: IPMIDevice) => readonly string[];
  logger?: SolProvisioningLogger;
}

export interface EnsureSolEnabledParams {
  // Null must NOT be coerced to '' — that collapses the LAN-channel cache key across BMCs; null skips caching.
  deviceId: string | null;
  bmcIp: string;
  username: string;
  password: string;
  port?: unknown;
}

export interface EnsureSolEnabledResult {
  channel: number;
  user_id: number;
  privilege: string;
  channel_sol_was_enabled: boolean;
  user_payload_was_enabled: boolean;
  actions: string[];
}

const PRIVILEGE_ORDER: Record<string, number> = { USER: 2, OPERATOR: 3, ADMINISTRATOR: 4 };

const FALLBACK_CHANNELS: readonly number[] = [1, 2, 3, 6, 7, 8, 0];

export function privilegeMeets(userPriv: string, requiredPriv: string): boolean {
  const userRank = PRIVILEGE_ORDER[userPriv.toUpperCase()] ?? 0;
  const requiredRank = PRIVILEGE_ORDER[requiredPriv.toUpperCase()] ?? 0;
  return userRank >= requiredRank;
}

export class SolPrerequisiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SolPrerequisiteError';
  }
}

interface SolInfoState {
  enabled: boolean;
  privilegeLevel: string;
}

const FORWARDING_LOGGER: SolProvisioningLogger = {
  info: (msg, ctx) => void getLogger().info(msg, ctx),
  warning: (msg, ctx) => void getLogger().warning(msg, ctx),
  debug: (msg, ctx) => void getLogger().debug(msg, ctx),
};

function resultError(result: IPMIResult): string {
  if (result.stderr) return result.stderr;
  if (result.timedOut) return 'Command timed out';
  if (result.ok) return '';
  return `Command failed (rc=${result.returncode === null ? null : String(result.returncode)})`;
}

function coerceIntStrict(value: string, original: string): number {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new Error(`invalid integer: '${original}'`);
  }
  return Number.parseInt(trimmed, 10);
}

function splitOnFirstWhitespace(line: string, maxSplit: number): string[] {
  const parts: string[] = [];
  let rest = line;
  for (let i = 0; i < maxSplit; i += 1) {
    const match = /\s+/.exec(rest);
    if (match === null || match.index === undefined) {
      break;
    }
    parts.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
  }
  parts.push(rest);
  return parts;
}

// eslint-disable-next-line no-control-regex -- deliberate: splitting on Unicode line terminators including \x1c-\x1e
const LINE_TERM_RE = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]');
function splitLines(value: string): string[] {
  if (value === '') return [];
  const parts = value.split(LINE_TERM_RE);
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

@Injectable()
export class SolProvisioningService {
  static readonly CACHE_TTL_SECONDS = 86400;

  readonly jobId: string;
  private readonly timeout: number;
  private readonly cache: SolProvisioningCache;
  private readonly getCipher: SolProvisioningCipherFn;
  private readonly transport: SolProvisioningTransportFn;
  private readonly handlers: SolProvisioningHandlers;
  private readonly buildBaseCommand: (device: IPMIDevice) => readonly string[];
  private readonly logger: SolProvisioningLogger;

  constructor(jobId: string, deps: SolProvisioningDeps) {
    this.jobId = jobId;
    this.timeout = getIpmiConfig().commandTimeout;
    this.cache = deps.cache;
    this.getCipher = deps.getCipher;
    this.transport = deps.transport;
    this.handlers = deps.handlers;
    this.buildBaseCommand = deps.buildBaseCommand;
    this.logger = deps.logger ?? FORWARDING_LOGGER;
  }

  async ensureSolEnabled(params: EnsureSolEnabledParams): Promise<EnsureSolEnabledResult> {
    const { deviceId, password } = params;
    const bmcIp = validateIp(params.bmcIp);
    const username = validateUsername(params.username);
    const portRaw = params.port === undefined ? 623 : params.port;
    const port = Math.trunc(Number(portRaw));
    if (!Number.isFinite(port)) {
      throw new TypeError(`port must be a finite number, received: ${String(portRaw)}`);
    }

    const baseDevice: IPMIDevice = {
      ip: bmcIp,
      username,
      password,
      port,
      cipher: null,
      jobId: this.jobId,
    };
    const cipher = await this.getCipher(baseDevice, deviceId);
    const device: IPMIDevice = { ...baseDevice, cipher };

    try {
      return await this.run(device, deviceId, username);
    } catch (exc) {
      if (exc instanceof SolPrerequisiteError) {
        const errLower = exc.message.toLowerCase();
        if (errLower.includes('invalid channel') || errLower.includes('parameter out of range')) {
          await this.logger.warning(
            `SOL prerequisite error may be stale channel cache; clearing and retrying: ${exc.message}`,
            { jobId: this.jobId },
          );
          if (deviceId) await this.cache.delete(deviceLanChannel(deviceId), this.jobId);
          return this.run(device, deviceId, username);
        }
      }
      throw exc;
    }
  }

  private async run(device: IPMIDevice, deviceId: string | null, username: string): Promise<EnsureSolEnabledResult> {
    const actions: string[] = [];

    const channel = await this.discoverChannel(device, deviceId);
    await this.logger.info(`LAN channel for ${device.ip}: ${channel}`, { jobId: this.jobId });

    const solInfo = await this.readSolInfo(device, channel);
    const channelSolWasEnabled = solInfo.enabled;

    if (!channelSolWasEnabled) {
      await this.enableChannelSol(device, channel);
      actions.push(`Enabled SOL on channel ${channel}`);
    } else {
      await this.logger.info('Channel SOL already enabled, skipping', { jobId: this.jobId });
    }

    const userId = await this.findUserId(device, channel, username);
    await this.logger.info(`IPMI user '${username}' has user ID ${userId}`, { jobId: this.jobId });

    const payloadStatus = await this.readUserPayloadStatus(device, channel, userId);
    let userPayloadWasEnabled: boolean;
    if (payloadStatus === null) {
      await this.logger.warning('sol payload status not supported; enabling unconditionally', { jobId: this.jobId });
      await this.enableUserPayload(device, channel, userId);
      userPayloadWasEnabled = false;
      actions.push(`Enabled SOL payload for user ${userId} on channel ${channel} (firmware fallback)`);
    } else if (!payloadStatus) {
      await this.enableUserPayload(device, channel, userId);
      userPayloadWasEnabled = false;
      actions.push(`Enabled SOL payload for user ${userId} on channel ${channel}`);
    } else {
      userPayloadWasEnabled = true;
      await this.logger.info('User SOL payload already enabled, skipping', { jobId: this.jobId });
    }

    const userPriv = await this.readUserPrivilege(device, channel, userId);
    const solMinPriv = solInfo.privilegeLevel;
    if (!privilegeMeets(userPriv, solMinPriv)) {
      throw new SolPrerequisiteError(
        `User '${username}' privilege ${userPriv} is below the channel SOL minimum ` +
          `${solMinPriv}. Elevate the user's privilege manually before retrying.`,
      );
    }
    await this.logger.info(`User privilege ${userPriv} meets SOL minimum ${solMinPriv}`, { jobId: this.jobId });

    if (actions.length > 0) {
      await this.logger.info(`SOL prerequisites configured: ${JSON.stringify(actions)}`, {
        jobId: this.jobId,
      });
    } else {
      await this.logger.info('All SOL prerequisites already satisfied, no changes made', {
        jobId: this.jobId,
      });
    }

    return {
      channel,
      user_id: userId,
      privilege: userPriv,
      channel_sol_was_enabled: channelSolWasEnabled,
      user_payload_was_enabled: userPayloadWasEnabled,
      actions,
    };
  }

  private async runRaw(device: IPMIDevice, extraArgv: readonly string[]): Promise<IPMIResult> {
    const command = [...this.buildBaseCommand(device), ...extraArgv];
    return this.transport(command, device.password, this.timeout, {
      cipherUsed: device.cipher,
      jobId: this.jobId,
    });
  }

  private async discoverChannel(device: IPMIDevice, deviceId: string | null): Promise<number> {
    if (deviceId) {
      const cached = await this.cache.get(deviceLanChannel(deviceId), this.jobId);
      if (cached !== null) {
        await this.logger.debug(`Cached LAN channel for device ${deviceId}: ${cached}`, {
          jobId: this.jobId,
        });
        return coerceIntStrict(cached, cached);
      }
    }

    let channel = await this.channelInfoThis(device);
    if (channel !== null) {
      if (deviceId) {
        await this.cache.set(
          deviceLanChannel(deviceId),
          String(channel),
          SolProvisioningService.CACHE_TTL_SECONDS,
          this.jobId,
        );
      }
      return channel;
    }

    await this.logger.warning('channel info 0x0e failed; falling back to lan print iteration', { jobId: this.jobId });
    channel = await this.channelByLanPrint(device);
    if (channel !== null) {
      if (deviceId) {
        await this.cache.set(
          deviceLanChannel(deviceId),
          String(channel),
          SolProvisioningService.CACHE_TTL_SECONDS,
          this.jobId,
        );
      }
      return channel;
    }

    throw new SolPrerequisiteError(
      `Unable to discover LAN channel for ${device.ip}. Both 'channel info 0x0e' and 'lan print' iteration failed.`,
    );
  }

  private async channelInfoThis(device: IPMIDevice): Promise<number | null> {
    const result = await this.runRaw(device, ['channel', 'info', '0x0e']);
    await this.logger.debug(`channel info 0x0e result: ok=${result.ok} stdout=${JSON.stringify(result.stdout)}`, {
      jobId: this.jobId,
    });

    if (!result.ok) {
      return null;
    }

    const match = /^Channel 0x([0-9a-fA-F]+) info:/m.exec(result.stdout);
    if (match !== null && match[1] !== undefined) {
      return Number.parseInt(match[1], 16);
    }
    return null;
  }

  private async channelByLanPrint(device: IPMIDevice): Promise<number | null> {
    for (const ch of FALLBACK_CHANNELS) {
      const result = await this.runRaw(device, ['lan', 'print', String(ch)]);
      if (!result.ok) {
        continue;
      }

      for (const line of splitLines(result.stdout)) {
        if (line.trim().startsWith('IP Address') && line.includes(':')) {
          const colonIdx = line.indexOf(':');
          const ipValue = line.slice(colonIdx + 1).trim();
          if (ipValue === device.ip) {
            await this.logger.debug(`lan print matched channel ${ch} to ${device.ip}`, {
              jobId: this.jobId,
            });
            return ch;
          }
        }
      }
    }
    return null;
  }

  private async findUserId(device: IPMIDevice, channel: number, username: string): Promise<number> {
    const result = await this.runRaw(device, ['user', 'list', String(channel)]);
    if (!result.ok) {
      throw new SolPrerequisiteError(`Failed to list users on channel ${channel}: ${resultError(result)}`);
    }

    await this.logger.debug(`user list output:\n${result.stdout}`, { jobId: this.jobId });

    const matches: number[] = [];
    for (const rawLine of splitLines(result.stdout)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('ID')) {
        continue;
      }
      const parts = splitOnFirstWhitespace(line, 2);
      if (parts.length < 2) {
        continue;
      }
      const first = parts[0];
      const second = parts[1];
      if (first === undefined || second === undefined) {
        continue;
      }
      if (!/^[+-]?\d+$/.test(first)) {
        continue;
      }
      const uid = Number.parseInt(first, 10);
      if (['true', 'false', 'on', 'off'].includes(second.toLowerCase())) {
        continue;
      }
      if (second === username) {
        matches.push(uid);
      }
    }

    if (matches.length === 0) {
      throw new SolPrerequisiteError(`User '${username}' not found in user list on channel ${channel}`);
    }
    if (matches.length > 1) {
      throw new SolPrerequisiteError(
        `Multiple user IDs matched '${username}' on channel ${channel}: ${JSON.stringify(matches)}`,
      );
    }
    const uid = matches[0];
    if (uid === undefined) {
      throw new SolPrerequisiteError(`User '${username}' not found in user list on channel ${channel}`);
    }
    return uid;
  }

  private async readSolInfo(device: IPMIDevice, channel: number): Promise<SolInfoState> {
    const result = await this.handlers.solInfo(device, channel, { timeout: this.timeout });
    if (!result.ok) {
      throw new SolPrerequisiteError(`Failed to read SOL info on channel ${channel}: ${resultError(result)}`);
    }

    await this.logger.debug(`sol info output:\n${result.stdout}`, { jobId: this.jobId });

    const enabledMatch = /^Enabled\s*:\s*(true|false)\s*$/im.exec(result.stdout);
    if (enabledMatch === null || enabledMatch[1] === undefined) {
      throw new SolPrerequisiteError(`Could not parse SOL enabled state from sol info output on channel ${channel}`);
    }

    const privMatch = /^Privilege Level\s*:\s*(\w+)\s*$/m.exec(result.stdout);
    if (privMatch === null || privMatch[1] === undefined) {
      throw new SolPrerequisiteError(`Could not parse SOL privilege level from sol info output on channel ${channel}`);
    }

    return {
      enabled: enabledMatch[1].toLowerCase() === 'true',
      privilegeLevel: privMatch[1].toUpperCase(),
    };
  }

  private async enableChannelSol(device: IPMIDevice, channel: number): Promise<void> {
    const result = await this.handlers.solSetEnabled(device, true, channel, {
      timeout: this.timeout,
    });
    if (!result.ok) {
      throw new SolPrerequisiteError(`Failed to enable SOL on channel ${channel}: ${resultError(result)}`);
    }
    await this.logger.info(`Enabled SOL on channel ${channel}`, { jobId: this.jobId });
  }

  private async readUserPayloadStatus(device: IPMIDevice, channel: number, userId: number): Promise<boolean | null> {
    const result = await this.handlers.solPayloadStatus(device, channel, userId, {
      timeout: this.timeout,
    });

    if (!result.ok) {
      const errLower = (result.stderr || result.stdout).toLowerCase();
      if (errLower.includes('invalid command') || errLower.includes('not supported') || errLower.includes('unknown')) {
        await this.logger.debug(`sol payload status not supported on this firmware: ${resultError(result)}`, {
          jobId: this.jobId,
        });
        return null;
      }
      throw new SolPrerequisiteError(
        `Failed to read SOL payload status for user ${userId} on channel ${channel}: ${resultError(result)}`,
      );
    }

    await this.logger.debug(`sol payload status output: ${result.stdout}`, { jobId: this.jobId });

    const match = /^User \d+ on channel \d+ is (enabled|disabled)\s*$/im.exec(result.stdout);
    if (match !== null && match[1] !== undefined) {
      return match[1].toLowerCase() === 'enabled';
    }

    await this.logger.warning(`Could not parse sol payload status output; treating as unknown: ${result.stdout}`, {
      jobId: this.jobId,
    });
    return null;
  }

  private async enableUserPayload(device: IPMIDevice, channel: number, userId: number): Promise<void> {
    const result = await this.handlers.solPayloadEnable(device, channel, userId, {
      timeout: this.timeout,
    });
    if (!result.ok) {
      throw new SolPrerequisiteError(
        `Failed to enable SOL payload for user ${userId} on channel ${channel}: ${resultError(result)}`,
      );
    }
    await this.logger.info(`Enabled SOL payload for user ${userId} on channel ${channel}`, {
      jobId: this.jobId,
    });
  }

  private async readUserPrivilege(device: IPMIDevice, channel: number, userId: number): Promise<string> {
    const result = await this.runRaw(device, ['channel', 'getaccess', String(channel), String(userId)]);
    if (!result.ok) {
      throw new SolPrerequisiteError(
        `Failed to read user access for user ${userId} on channel ${channel}: ${resultError(result)}`,
      );
    }

    await this.logger.debug(`channel getaccess output:\n${result.stdout}`, { jobId: this.jobId });

    const match = /^Privilege Level\s*:\s*(\w+)\s*$/m.exec(result.stdout);
    if (match === null || match[1] === undefined) {
      throw new SolPrerequisiteError(
        `Could not parse privilege level from channel getaccess output for user ${userId} on channel ${channel}`,
      );
    }
    return match[1].toUpperCase();
  }
}
