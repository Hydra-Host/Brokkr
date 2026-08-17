import { Injectable } from '@nestjs/common';

import type { SagaContext } from '../../saga-framework/saga.types';
import { validateIp, validateUsername } from '../ipmi/validation.js';

import { credsFromContext } from './power-control-context';
import type { StepLoggerLike } from './power-management-service.types';

interface IpmiResultLike {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string;
}

interface IpmiDeviceLike {
  readonly ip: string;
  readonly username: string;
  readonly password: string;
  readonly port: number;
  readonly cipher: string | null;
  readonly jobId: string;
}

interface IpmiDeviceFactoryLike {
  create(args: { ip: string; username: string; password: string; port: number; jobId: string }): IpmiDeviceLike;
  withCipher(device: IpmiDeviceLike, cipher: string | null): IpmiDeviceLike;
}

interface IpmiPingerLike {
  pingWithRetry(bmcIp: string, port: number, opts: { jobId: string }): Promise<boolean>;
}

interface CipherResolverLike {
  getCipherForDevice(device: IpmiDeviceLike, deviceId: string | null): Promise<string | null>;
}

interface McHandlersLike {
  mcReset(device: IpmiDeviceLike, mode: string): Promise<IpmiResultLike>;
}

interface SleeperLike {
  sleep(seconds: number): Promise<void>;
}

@Injectable()
export class PcBmcResetColdStep {
  constructor(
    private readonly deviceFactory: IpmiDeviceFactoryLike,
    private readonly pinger: IpmiPingerLike,
    private readonly cipherResolver: CipherResolverLike,
    private readonly mc: McHandlersLike,
    private readonly logger: StepLoggerLike,
    private readonly sleeper: SleeperLike,
  ) {}

  async execute(ctx: SagaContext): Promise<Record<string, unknown>> {
    const payload = ctx.payload;
    const creds = credsFromContext(ctx);
    const bmcIp = validateIp(creds.bmcIp);
    const username = validateUsername(creds.username);
    const password = creds.password;
    const port = toInt(payload['port'] ?? 623);
    const jobId = ctx.jobId;

    await this.logger.info('Starting IPMI operation', { jobId });

    if (!(await this.pinger.pingWithRetry(bmcIp, port, { jobId }))) {
      const msg = `IPMI ping failed - IP ${bmcIp} is not reachable`;
      await this.logger.error(msg, { jobId });
      throw new Error(`BMC cold reset failed: ${msg}`);
    }

    let device = this.deviceFactory.create({ ip: bmcIp, username, password, port, jobId });
    const deviceId =
      ctx.deviceId !== null && ctx.deviceId !== undefined && ctx.deviceId !== '' ? String(ctx.deviceId) : null;
    const cipher = await this.cipherResolver.getCipherForDevice(device, deviceId);
    device = this.deviceFactory.withCipher(device, cipher);

    await this.logger.info('Issuing BMC cold reset (mc reset cold)', { jobId });

    const maxRetries = 3;
    let lastError = '';
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await this.logger.info(`IPMI 'cold' attempt ${attempt}/${maxRetries}`, { jobId });
      const result = await this.mc.mcReset(device, 'cold');

      if (result.ok) {
        await this.logger.info(`IPMI 'cold' succeeded on attempt ${attempt}`, { jobId });
        await this.logger.info('BMC cold reset command accepted', { jobId });
        return { reset_type: 'cold', result: 'success' };
      }

      lastError = result.error;
      await this.logger.warning(`IPMI 'cold' attempt ${attempt} failed: ${lastError}`, { jobId });

      if (attempt < maxRetries) {
        const backoff = Math.min(4 * Math.pow(2, attempt - 1), 10);
        await this.logger.info(`Waiting ${backoff}s before retry`, { jobId });
        await this.sleeper.sleep(backoff);
      }
    }

    await this.logger.error(`IPMI 'cold' failed after ${maxRetries} attempts: ${lastError}`, { jobId });
    throw new Error(`BMC cold reset failed: ${lastError || 'unknown error'}`);
  }
}

function toInt(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new TypeError(`Cannot convert ${String(value)} to integer`);
  }
  return Math.trunc(n);
}
