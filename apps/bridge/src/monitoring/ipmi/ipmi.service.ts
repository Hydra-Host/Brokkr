import { Injectable } from '@nestjs/common';

import { IPMIValidationError } from '../../oob/ipmi/validation';

export { IPMIValidationError };

export class IPMIMonitoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IPMIMonitoringError';
  }
}

export interface IPMIResultLike {
  ok: boolean;
  stdout: string;
  stderr: string;
  command: readonly string[];
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

export interface IPMIValidatorLike {
  validateIp(ip: string): string;
  validateUsername(username: string): string;
  validatePort(port: unknown): number;
  validateIpmiCommand(parts: readonly string[]): string[];
}

export interface IPMIPingAdapterLike {
  ipmiPing(ip: string, opts: { jobId: string }): Promise<boolean>;
}

export interface IPMICipherAdapterLike {
  getCipherForDevice(device: IPMIDeviceLike): Promise<string | null>;
}

export interface IPMIMetricsAdapterLike {
  executeMetricsCommand(
    device: IPMIDeviceLike,
    parts: readonly string[],
    opts: { timeout: number | null },
  ): Promise<IPMIResultLike>;
}

export interface IPMIBatchAdapterLike {
  executeBatch(device: IPMIDeviceLike, commands: readonly unknown[]): Promise<IPMIResultLike[]>;
}

export interface LoggerLike {
  debug(message: string, context?: { jobId?: string }): Promise<void>;
  error(message: string, context?: { jobId?: string }): Promise<void>;
}

export interface IPMIMonitoringServiceDeps {
  deviceFactory: IPMIDeviceFactoryLike;
  validators: IPMIValidatorLike;
  ping: IPMIPingAdapterLike;
  cipher: IPMICipherAdapterLike;
  metrics: IPMIMetricsAdapterLike;
  batch: IPMIBatchAdapterLike;
  logger: LoggerLike;
}

export interface IPMICommandWire {
  result: 'success' | 'failure';
  response: string;
  command: string[];
  target_ip: string;
  cipher_used?: string;
}

export interface IPMIBatchResultWire {
  result: 'success' | 'failure';
  response: string;
  command: string[];
}

export interface IPMIBatchWire {
  target_ip: string;
  total_commands: number;
  successful: number;
  failed: number;
  results: IPMIBatchResultWire[];
  cipher_used?: string;
}

function normalize(command: unknown): string[] {
  if (typeof command === 'string') {
    const trimmed = command.trim();
    return trimmed === '' ? [] : trimmed.split(/\s+/);
  }
  if (Array.isArray(command)) {
    return command.map((v) => String(v));
  }
  throw new TypeError('Command must be a string or array');
}

function toWire(result: IPMIResultLike, command: string[], targetIp: string, cipher: string | null): IPMICommandWire {
  const wire: IPMICommandWire = {
    result: result.ok ? 'success' : 'failure',
    response: result.ok ? result.stdout : result.stderr,
    command,
    target_ip: targetIp,
  };
  if (cipher !== null) wire.cipher_used = cipher;
  return wire;
}

@Injectable()
export class IPMIMonitoringService {
  readonly jobId: string;

  constructor(
    private readonly deps: IPMIMonitoringServiceDeps,
    jobId = '',
  ) {
    this.jobId = jobId;
  }

  private async prepareDevice(
    ip: string,
    username: string,
    password: string,
    port: number,
  ): Promise<{ device: IPMIDeviceLike; cipher: string | null }> {
    const canonicalIp = this.deps.validators.validateIp(ip);
    if (!(await this.deps.ping.ipmiPing(canonicalIp, { jobId: this.jobId }))) {
      throw new IPMIMonitoringError(`IPMI ping failed - IP ${canonicalIp} is not reachable`);
    }
    let device = this.deps.deviceFactory.create({
      ip: canonicalIp,
      username: this.deps.validators.validateUsername(username),
      password: String(password).slice(0, 128),
      port: this.deps.validators.validatePort(port),
      jobId: this.jobId,
    });
    const cipher = await this.deps.cipher.getCipherForDevice(device);
    await this.deps.logger.debug(`Prepared IPMI device ${canonicalIp}: cipher=${cipher ?? 'unknown'}`, {
      jobId: this.jobId,
    });
    device = device.withCipher(cipher);
    return { device, cipher };
  }

  async executeIpmiCommand(
    ip: string,
    username: string,
    password: string,
    command: unknown,
    port = 623,
    timeout: number | null = null,
  ): Promise<IPMICommandWire> {
    try {
      const { device, cipher } = await this.prepareDevice(ip, username, password, port);
      const validated = this.deps.validators.validateIpmiCommand(normalize(command));
      const result = await this.deps.metrics.executeMetricsCommand(device, validated, { timeout });
      return toWire(result, validated, device.ip, cipher);
    } catch (e) {
      if (e instanceof IPMIMonitoringError || e instanceof IPMIValidationError || e instanceof TypeError) {
        throw e;
      }
      await this.deps.logger.error(`IPMI command execution failed: ${e instanceof Error ? e.message : String(e)}`, {
        jobId: this.jobId,
      });
      throw new Error('Internal error during IPMI command execution');
    }
  }

  async executeBatchIpmiCommands(
    ip: string,
    username: string,
    password: string,
    commands: readonly unknown[],
    port = 623,
  ): Promise<IPMIBatchWire> {
    if (commands.length > 20) {
      throw new RangeError('Maximum 20 commands per batch');
    }
    try {
      const { device, cipher } = await this.prepareDevice(ip, username, password, port);
      const adapterResults = await this.deps.batch.executeBatch(device, commands);
      const wireResults: IPMIBatchResultWire[] = adapterResults.map((r) => ({
        result: r.ok ? 'success' : 'failure',
        response: r.ok ? r.stdout : r.stderr,
        command: [...r.command],
      }));
      const response: IPMIBatchWire = {
        target_ip: device.ip,
        total_commands: commands.length,
        successful: wireResults.filter((w) => w.result === 'success').length,
        failed: wireResults.filter((w) => w.result === 'failure').length,
        results: wireResults,
      };
      if (cipher !== null) response.cipher_used = cipher;
      return response;
    } catch (e) {
      if (e instanceof IPMIMonitoringError || e instanceof IPMIValidationError) {
        throw e;
      }
      await this.deps.logger.error(`Batch IPMI execution failed: ${e instanceof Error ? e.message : String(e)}`, {
        jobId: this.jobId,
      });
      throw new Error('Internal error during batch IPMI execution');
    }
  }
}

export function createIpmiMonitoringService(deps: IPMIMonitoringServiceDeps, jobId = ''): IPMIMonitoringService {
  return new IPMIMonitoringService(deps, jobId);
}
