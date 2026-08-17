import { Injectable } from '@nestjs/common';

import type { BmcCredentials } from '../../common/bmc.types';
import { validateIp, validateUsername } from '../ipmi/validation.js';

const BOOT_DEVICE_SELECTORS: Readonly<Record<string, string>> = {
  pxe: 'Force PXE',
  disk: 'Force Boot from default Hard-Drive',
  cdrom: 'Force Boot from CD/DVD',
  bios: 'Force Boot into BIOS Setup',
};

export class PowerManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PowerManagementError';
  }
}

export interface IpmiResultLike {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: string;
}

export interface IpmiDeviceLike {
  readonly ip: string;
  readonly username: string;
  readonly password: string;
  withCipher(cipher: string | null): IpmiDeviceLike;
}

export interface IpmiDeviceFactoryLike {
  create(args: { ip: string; username: string; password: string; jobId: string }): IpmiDeviceLike;
}

export interface IpmiCipherResolverLike {
  resolveCipher(device: IpmiDeviceLike, deviceId: string | null): Promise<[boolean, string | null]>;
}

export interface IpmiPingerLike {
  ping(bmcIp: string, opts: { jobId: string }): Promise<boolean>;
  pingWithRetry(bmcIp: string, opts: { jobId: string }): Promise<boolean>;
}

export interface PowerHandlersLike {
  power(device: IpmiDeviceLike, operation: string): Promise<IpmiResultLike>;
  powerStatus(device: IpmiDeviceLike): Promise<string>;
  getBootParam(device: IpmiDeviceLike, paramId: number): Promise<IpmiResultLike>;
}

export interface IpmiRetryLike {
  performIpmiWithRetry(
    device: IpmiDeviceLike,
    operation: string,
    jobId: string,
    opts: { maxRetries: number; uefi?: boolean },
  ): Promise<Record<string, unknown>>;
}

export interface LoggerLike {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  warning(message: string, context?: { jobId?: string }): Promise<void>;
  error(message: string, context?: { jobId?: string }): Promise<void>;
}

export interface SleeperLike {
  sleep(seconds: number): Promise<void>;
}

export interface ClockLike {
  monotonic(): number;
}

export interface PowerManagementDeps {
  readonly deviceFactory: IpmiDeviceFactoryLike;
  readonly cipherResolver: IpmiCipherResolverLike;
  readonly pinger: IpmiPingerLike;
  readonly powerHandlers: PowerHandlersLike;
  readonly retry: IpmiRetryLike;
  readonly logger: LoggerLike;
  readonly sleeper: SleeperLike;
  readonly clock: ClockLike;
}

@Injectable()
export class PowerManagementService {
  private readonly jobId: string;
  private readonly deps: PowerManagementDeps;
  private device: IpmiDeviceLike | null = null;

  constructor(jobId: string, deps: PowerManagementDeps) {
    this.jobId = jobId;
    this.deps = deps;
  }

  private async resolveDevice(creds: BmcCredentials): Promise<IpmiDeviceLike> {
    const bmcIp = validateIp(creds.bmcIp);
    const username = validateUsername(creds.username);

    // Match on full creds — a mid-job password rotation must not reuse a stale device.
    if (
      this.device !== null &&
      this.device.ip === bmcIp &&
      this.device.username === username &&
      this.device.password === creds.password
    ) {
      return this.device;
    }

    if (!(await this.deps.pinger.pingWithRetry(bmcIp, { jobId: this.jobId }))) {
      await this.deps.logger.error(`IPMI ping failed - IP ${bmcIp} is not reachable`, { jobId: this.jobId });
      throw new PowerManagementError(`IPMI ping failed - IP ${bmcIp} is not reachable`);
    }

    let device = this.deps.deviceFactory.create({
      ip: bmcIp,
      username,
      password: creds.password,
      jobId: this.jobId,
    });
    const [found, cipher] = await this.deps.cipherResolver.resolveCipher(device, null);
    device = device.withCipher(cipher);
    if (found) {
      this.device = device;
    } else {
      await this.deps.logger.warning(`Cipher detection failed for ${bmcIp}; not caching device`, {
        jobId: this.jobId,
      });
    }
    return device;
  }

  async validateCredentials(
    creds: BmcCredentials,
    opts: { maxRetries?: number } = {},
  ): Promise<Record<string, unknown>> {
    const maxRetries = opts.maxRetries ?? 2;
    const device = await this.resolveDevice(creds);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await this.deps.logger.info(`IPMI credential validation attempt ${attempt}/${maxRetries} for ${creds.bmcIp}`, {
        jobId: this.jobId,
      });
      const result = await this.deps.powerHandlers.power(device, 'status');

      if (result.ok) {
        await this.deps.logger.info(`IPMI credential validation succeeded on attempt ${attempt}`, {
          jobId: this.jobId,
        });
        return { ipmi_valid: true };
      }

      await this.deps.logger.warning(`IPMI validation attempt ${attempt} failed: ${result.error}`, {
        jobId: this.jobId,
      });
      if (attempt < maxRetries) {
        await this.deps.sleeper.sleep(5);
      }
    }

    await this.deps.logger.error(`IPMI credential validation failed after ${maxRetries} attempts`, {
      jobId: this.jobId,
    });
    throw new PowerManagementError('IPMI credential validation failed');
  }

  async powerOff(creds: BmcCredentials): Promise<Record<string, unknown>> {
    const device = await this.resolveDevice(creds);

    const currentState = await this.deps.powerHandlers.powerStatus(device);
    if (currentState === 'off') {
      await this.deps.logger.info('Server already powered off', { jobId: this.jobId });
      return { power_state: 'off', already_off: true };
    }

    await this.deps.logger.info('Sending graceful power off (ACPI soft shutdown)', {
      jobId: this.jobId,
    });
    await this.deps.retry.performIpmiWithRetry(device, 'soft', this.jobId, { maxRetries: 3 });

    return { power_state: 'off', method: 'soft' };
  }

  async verifyPowerOff(
    creds: BmcCredentials,
    opts: { softTimeout?: number; hardTimeout?: number; pollInterval?: number } = {},
  ): Promise<Record<string, unknown>> {
    const softTimeout = opts.softTimeout ?? 90;
    const hardTimeout = opts.hardTimeout ?? 30;
    const pollInterval = opts.pollInterval ?? 10;
    const device = await this.resolveDevice(creds);

    const start = this.deps.clock.monotonic();
    await this.deps.logger.info(`Verifying power off (soft timeout ${softTimeout}s)`, {
      jobId: this.jobId,
    });

    while (this.deps.clock.monotonic() - start < softTimeout) {
      const state = await this.deps.powerHandlers.powerStatus(device);
      if (state === 'off') {
        const elapsed = Math.trunc(this.deps.clock.monotonic() - start);
        await this.deps.logger.info(`Power off verified after ${elapsed}s (soft shutdown)`, {
          jobId: this.jobId,
        });
        return { verified: true, elapsed_seconds: elapsed, method: 'soft' };
      }
      await this.deps.sleeper.sleep(pollInterval);
    }

    await this.deps.logger.warning('Soft shutdown timed out, escalating to hard power off', {
      jobId: this.jobId,
    });
    await this.deps.retry.performIpmiWithRetry(device, 'off', this.jobId, { maxRetries: 3 });

    const hardStart = this.deps.clock.monotonic();
    while (this.deps.clock.monotonic() - hardStart < hardTimeout) {
      const state = await this.deps.powerHandlers.powerStatus(device);
      if (state === 'off') {
        const elapsed = Math.trunc(this.deps.clock.monotonic() - start);
        await this.deps.logger.info(`Power off verified after ${elapsed}s (hard shutdown)`, {
          jobId: this.jobId,
        });
        return { verified: true, elapsed_seconds: elapsed, method: 'hard' };
      }
      await this.deps.sleeper.sleep(pollInterval);
    }

    const elapsed = Math.trunc(this.deps.clock.monotonic() - start);
    throw new PowerManagementError(`Server did not power off after ${elapsed}s (soft + hard)`);
  }

  async setBootDevice(creds: BmcCredentials, bootDevice: unknown = 'pxe'): Promise<Record<string, unknown>> {
    const device = await this.resolveDevice(creds);
    const op = String(bootDevice);

    await this.deps.logger.info(`Setting boot device to '${op}'`, { jobId: this.jobId });
    const result = await this.deps.retry.performIpmiWithRetry(device, op, this.jobId, {
      maxRetries: 3,
      uefi: true,
    });

    return { device: bootDevice, uefi: true, result: result['result'] };
  }

  async verifyBootDevice(creds: BmcCredentials, bootDevice: unknown = 'pxe'): Promise<Record<string, unknown>> {
    const key = typeof bootDevice === 'string' ? bootDevice : String(bootDevice);
    const expectedSelector = Object.prototype.hasOwnProperty.call(BOOT_DEVICE_SELECTORS, key)
      ? BOOT_DEVICE_SELECTORS[key]
      : undefined;
    const device = await this.resolveDevice(creds);

    const result = await this.deps.powerHandlers.getBootParam(device, 5);
    if (!result.ok) {
      throw new PowerManagementError(`Failed to read boot param 5: ${result.error}`);
    }

    const response = result.stdout;

    const match = /Boot Device Selector\s*:\s*(.+)/.exec(response);
    if (!match) {
      await this.deps.logger.warning(`Could not parse boot device from output: ${response}`, { jobId: this.jobId });
      return {
        verified: false,
        reason: 'could not parse output',
        raw: response,
      };
    }

    const actualSelector = match[1].trim();

    if (expectedSelector !== undefined && actualSelector.includes(expectedSelector)) {
      await this.deps.logger.info(`Boot device verified: ${actualSelector}`, {
        jobId: this.jobId,
      });
      return { verified: true, device: actualSelector };
    }

    const expectedRepr = expectedSelector === undefined ? null : expectedSelector;
    await this.deps.logger.warning(`Boot device mismatch: expected '${expectedRepr}', got '${actualSelector}'`, {
      jobId: this.jobId,
    });
    throw new PowerManagementError(`Boot device mismatch: expected '${expectedRepr}', got '${actualSelector}'`);
  }

  async powerOn(creds: BmcCredentials): Promise<Record<string, unknown>> {
    const device = await this.resolveDevice(creds);

    const currentState = await this.deps.powerHandlers.powerStatus(device);
    if (currentState === 'on') {
      await this.deps.logger.info('Server already powered on', { jobId: this.jobId });
      return { power_state: 'on', already_on: true };
    }

    await this.deps.logger.info('Sending power on', { jobId: this.jobId });
    await this.deps.retry.performIpmiWithRetry(device, 'on', this.jobId, { maxRetries: 3 });

    return { power_state: 'on' };
  }

  async verifyPowerOn(
    creds: BmcCredentials,
    opts: { timeout?: number; pollInterval?: number } = {},
  ): Promise<Record<string, unknown>> {
    const timeout = opts.timeout ?? 60;
    const pollInterval = opts.pollInterval ?? 10;
    const device = await this.resolveDevice(creds);

    const start = this.deps.clock.monotonic();
    await this.deps.logger.info(`Verifying power on (timeout ${timeout}s)`, {
      jobId: this.jobId,
    });

    while (this.deps.clock.monotonic() - start < timeout) {
      const state = await this.deps.powerHandlers.powerStatus(device);
      if (state === 'on') {
        const elapsed = Math.trunc(this.deps.clock.monotonic() - start);
        await this.deps.logger.info(`Power on verified after ${elapsed}s`, {
          jobId: this.jobId,
        });
        return { verified: true, elapsed_seconds: elapsed };
      }
      await this.deps.sleeper.sleep(pollInterval);
    }

    const elapsed = Math.trunc(this.deps.clock.monotonic() - start);
    throw new PowerManagementError(`Server did not power on after ${elapsed}s`);
  }

  async bmcResetCold(creds: BmcCredentials): Promise<Record<string, unknown>> {
    const device = await this.resolveDevice(creds);

    await this.deps.logger.info('Issuing BMC cold reset (mc reset cold)', { jobId: this.jobId });
    const result = await this.deps.retry.performIpmiWithRetry(device, 'cold', this.jobId, {
      maxRetries: 3,
    });

    if (result['result'] !== 'success') {
      const response =
        'response' in result && result['response'] !== undefined ? String(result['response']) : 'unknown error';
      throw new PowerManagementError(`BMC cold reset failed: ${response}`);
    }

    await this.deps.logger.info('BMC cold reset command accepted', { jobId: this.jobId });
    return { reset_type: 'cold', result: result['result'] };
  }

  async verifyBmcRecovery(
    creds: BmcCredentials,
    opts: { initialDelay?: number; pollInterval?: number; timeout?: number } = {},
  ): Promise<Record<string, unknown>> {
    const initialDelay = opts.initialDelay ?? 30;
    const pollInterval = opts.pollInterval ?? 10;
    const timeout = opts.timeout ?? 300;

    await this.deps.logger.info(`Waiting ${initialDelay}s for BMC to begin reboot cycle`, {
      jobId: this.jobId,
    });
    await this.deps.sleeper.sleep(initialDelay);

    const start = this.deps.clock.monotonic();
    const remaining = timeout - initialDelay;
    await this.deps.logger.info(`Polling BMC recovery on ${creds.bmcIp} (timeout ${remaining}s)`, {
      jobId: this.jobId,
    });

    while (this.deps.clock.monotonic() - start < remaining) {
      if (await this.deps.pinger.ping(creds.bmcIp, { jobId: this.jobId })) {
        const elapsed = Math.trunc(this.deps.clock.monotonic() - start) + initialDelay;
        await this.deps.logger.info(`BMC recovered after ${elapsed}s`, { jobId: this.jobId });
        return { recovered: true, elapsed_seconds: elapsed };
      }
      await this.deps.sleeper.sleep(pollInterval);
    }

    throw new PowerManagementError(`BMC did not recover within ${timeout}s after cold reset`);
  }
}

export class PowerManagementServiceFactory {
  constructor(private readonly deps: PowerManagementDeps) {}

  async create(jobId: string): Promise<PowerManagementService> {
    return new PowerManagementService(jobId, this.deps);
  }
}
