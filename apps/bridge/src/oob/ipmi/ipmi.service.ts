import { Injectable } from '@nestjs/common';

import { jsonFlag } from '../../saga-framework/dispatch-payload';

import { validateIp, validateUsername } from './validation.js';

export class IPMIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IPMIError';
  }
}

export interface IPMIResultLike {
  ok: boolean;
  stdout: string;
  stderr: string;
  error: string;
}

export interface IPMIDeviceLike {
  ip: string;
  username: string;
  password: string;
  port: number;
  cipher: string | null;
  jobId: string;
  withCipher(cipher: string | null): IPMIDeviceLike;
}

export interface IPMIDeviceFactoryLike {
  create(args: { ip: string; username: string; password: string; port: number; jobId: string }): IPMIDeviceLike;
}

export interface IPMIPingAdapterLike {
  ipmiPingOutcome(
    ip: string,
    opts: { port: number; timeout: number; jobId: string },
  ): Promise<'reachable' | 'timeout' | 'no_response' | 'error'>;
}

export interface IPMICipherAdapterLike {
  getCipherForDevice(device: IPMIDeviceLike): Promise<string | null>;
}

export interface IPMIPowerAdapterLike {
  power(device: IPMIDeviceLike, op: string): Promise<IPMIResultLike>;
  shouldExecutePowerOp(device: IPMIDeviceLike, op: string): Promise<boolean>;
  bootDevice(device: IPMIDeviceLike, target: string, opts: { uefi: boolean }): Promise<IPMIResultLike>;
}

export interface IPMIMcAdapterLike {
  mcReset(device: IPMIDeviceLike, mode: string): Promise<IPMIResultLike>;
}

export interface LoggerLike {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  error(message: string, context?: { jobId?: string }): Promise<void>;
}

export interface IPMIServiceDeps {
  deviceFactory: IPMIDeviceFactoryLike;
  ping: IPMIPingAdapterLike;
  cipher: IPMICipherAdapterLike;
  power: IPMIPowerAdapterLike;
  mc: IPMIMcAdapterLike;
  logger: LoggerLike;
}

const POWER_OPS = ['on', 'off', 'soft', 'status', 'cycle', 'reset'] as const;
const BOOT_OPS = ['disk', 'bios', 'pxe', 'cdrom'] as const;
const MC_RESET_OPS = ['cold', 'warm'] as const;
const VALID_OPERATIONS: readonly string[] = [...POWER_OPS, ...BOOT_OPS, ...MC_RESET_OPS, 'ping'];

type PowerOp = (typeof POWER_OPS)[number];
type BootOp = (typeof BOOT_OPS)[number];
type McResetOp = (typeof MC_RESET_OPS)[number];

function isPowerOp(op: string): op is PowerOp {
  return (POWER_OPS as readonly string[]).includes(op);
}

function isBootOp(op: string): op is BootOp {
  return (BOOT_OPS as readonly string[]).includes(op);
}

function isMcResetOp(op: string): op is McResetOp {
  return (MC_RESET_OPS as readonly string[]).includes(op);
}

export type LegacyIpmiOutcome = { result: 'success' | 'failure'; response: string };

function toInt(value: unknown): number {
  if (value === null || value === undefined) {
    throw new TypeError(`Cannot convert ${value} to integer`);
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Cannot convert non-finite number to integer');
    }
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[+-]?\d(_?\d)*$/.test(trimmed)) {
      throw new Error(`Invalid integer string: '${value}'`);
    }
    return Number(trimmed.replace(/_/g, ''));
  }
  throw new TypeError(`Cannot convert ${typeof value} to integer`);
}

function resultToLegacy(result: IPMIResultLike): LegacyIpmiOutcome {
  return {
    result: result.ok ? 'success' : 'failure',
    response: result.ok ? result.stdout : result.stderr || result.error,
  };
}

@Injectable()
export class IPMIService {
  readonly jobId: string;

  constructor(
    private readonly deps: IPMIServiceDeps,
    jobId = '',
  ) {
    this.jobId = jobId;
  }

  async validatePayload(payload: Record<string, unknown>): Promise<void> {
    const operation = payload.operation;
    const required = operation !== 'ping' ? ['bmc_ip', 'operation', 'username', 'password'] : ['bmc_ip', 'operation'];
    const missing = required.filter((f) => {
      const v = payload[f];
      if (v === undefined || v === null) return true;
      if (v === '' || v === false) return true;
      if (typeof v === 'number') return v === 0 || Number.isNaN(v);
      if (Array.isArray(v)) return v.length === 0;
      if (typeof v === 'object') return Object.keys(v as object).length === 0;
      return false;
    });
    if (missing.length > 0) {
      const msg = `Missing or empty required fields: ${missing.join(', ')}`;
      await this.deps.logger.error(msg, { jobId: this.jobId });
      throw new IPMIError(msg);
    }
    try {
      const portRaw = payload.port === undefined ? 623 : payload.port;
      const port = toInt(portRaw);
      if (!(port >= 1 && port <= 65535)) {
        throw new Error('Port number must be between 1 and 65535');
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const msg = `Invalid port: ${detail}`;
      await this.deps.logger.error(msg, { jobId: this.jobId });
      throw new IPMIError(msg);
    }
    if (typeof operation !== 'string' || !VALID_OPERATIONS.includes(operation)) {
      const msg = `Invalid operation: ${JSON.stringify(operation)}. Valid operations: ${JSON.stringify([...VALID_OPERATIONS])}`;
      await this.deps.logger.error(msg, { jobId: this.jobId });
      throw new IPMIError(msg);
    }
    await this.deps.logger.info(`Payload validation successful for operation: ${operation}`, { jobId: this.jobId });
  }

  async performIpmiPing(ipmiIp: string, port = 623, timeout = 2.0): Promise<LegacyIpmiOutcome> {
    const outcome = await this.deps.ping.ipmiPingOutcome(ipmiIp, {
      port,
      timeout,
      jobId: this.jobId,
    });
    if (outcome === 'reachable') {
      return {
        result: 'success',
        response: `IPMI ping successful - BMC is reachable on ${ipmiIp}:${port}`,
      };
    }
    if (outcome === 'timeout') {
      return {
        result: 'failure',
        response: `IPMI ping timeout - no response from ${ipmiIp}:${port} within ${Number.isInteger(timeout) ? `${timeout}.0` : timeout}s`,
      };
    }
    return {
      result: 'failure',
      response: `IPMI ping failed - no response from ${ipmiIp}:${port}`,
    };
  }

  async performIpmiOperation(payload: Record<string, unknown>): Promise<LegacyIpmiOutcome> {
    await this.validatePayload(payload);

    const bmcIp = validateIp(payload.bmc_ip);
    const operation = payload.operation as string;
    const port = toInt(payload.port === undefined ? 623 : payload.port);

    const pingResult = await this.performIpmiPing(bmcIp, port);
    if (operation === 'ping') return pingResult;
    if (pingResult.result === 'failure') {
      await this.deps.logger.error(`IPMI ping failed - IP ${bmcIp} is not reachable`, { jobId: this.jobId });
      return {
        result: 'failure',
        response: `IPMI ping failed - IP ${bmcIp} is not reachable`,
      };
    }

    const username = validateUsername(payload.username);
    const password = payload.password as string;
    const uefi: boolean = 'uefi' in payload ? jsonFlag(payload.uefi) : true;

    let device = this.deps.deviceFactory.create({
      ip: bmcIp,
      username,
      password,
      port,
      jobId: this.jobId,
    });
    device = device.withCipher(await this.deps.cipher.getCipherForDevice(device));

    let result: IPMIResultLike;
    if (isPowerOp(operation)) {
      if (operation === 'on' || operation === 'off' || operation === 'soft') {
        if (!(await this.deps.power.shouldExecutePowerOp(device, operation))) {
          const msg = `Server is already in desired power state (${operation})`;
          await this.deps.logger.info(msg, { jobId: this.jobId });
          return { result: 'success', response: msg };
        }
      }
      result = await this.deps.power.power(device, operation);
    } else if (isBootOp(operation)) {
      result = await this.deps.power.bootDevice(device, operation, { uefi });
    } else if (isMcResetOp(operation)) {
      result = await this.deps.mc.mcReset(device, operation);
    } else {
      throw new IPMIError(`Unknown operation: ${operation}`);
    }

    return resultToLegacy(result);
  }
}

export async function createIpmiService(deps: IPMIServiceDeps, jobId = ''): Promise<IPMIService> {
  return new IPMIService(deps, jobId);
}
