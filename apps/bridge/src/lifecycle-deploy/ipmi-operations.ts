import type { IPMIDevice } from '../oob/ipmi/device.js';
import { mcReset } from '../oob/ipmi/handlers/mc.js';
import { bootDevice, power, shouldExecutePowerOp } from '../oob/ipmi/handlers/power.js';
import { ipmiPing } from '../oob/ipmi/ping.js';
import { type IPMIResult, resultError } from '../oob/ipmi/result.js';

import { getLogger } from '../logger/logger.service';

const logInfo = (msg: string, ctx?: { jobId?: string }): void => void getLogger().info(msg, ctx);
const logWarning = (msg: string, ctx?: { jobId?: string }): void => void getLogger().warning(msg, ctx);
const logError = (msg: string, ctx?: { jobId?: string }): void => void getLogger().error(msg, ctx);

const POWER_OPS: readonly string[] = ['on', 'off', 'soft', 'status', 'cycle', 'reset'];
const IDEMPOTENT_POWER_OPS: readonly string[] = ['on', 'off', 'soft'];
const BOOT_OPS: readonly string[] = ['disk', 'bios', 'pxe', 'cdrom'];
const MC_RESET_OPS: readonly string[] = ['cold', 'warm'];

export interface LegacyIpmiResult extends Record<string, unknown> {
  result: 'success' | 'failure';
  response: string;
}

export interface IpmiRetryDeps {
  power: typeof power;
  bootDevice: typeof bootDevice;
  mcReset: typeof mcReset;
  ipmiPing: typeof ipmiPing;
  shouldExecutePowerOp: typeof shouldExecutePowerOp;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: IpmiRetryDeps = {
  power,
  bootDevice,
  mcReset,
  ipmiPing,
  shouldExecutePowerOp,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function toLegacy(result: IPMIResult): LegacyIpmiResult {
  return {
    result: result.ok ? 'success' : 'failure',
    response: result.ok ? result.stdout : result.stderr || resultError(result),
  };
}

async function dispatchOp(
  device: IPMIDevice,
  operation: string,
  bootOptions: { uefi: boolean; persistent: boolean },
  deps: IpmiRetryDeps,
): Promise<IPMIResult> {
  if (POWER_OPS.includes(operation)) {
    return deps.power(device, operation);
  }
  if (BOOT_OPS.includes(operation)) {
    return deps.bootDevice(device, operation, bootOptions);
  }
  if (MC_RESET_OPS.includes(operation)) {
    return deps.mcReset(device, operation);
  }
  throw new Error(`Unknown IPMI operation for retry wrapper: '${operation}'`);
}

export async function performIpmiWithRetry(
  device: IPMIDevice,
  operation: string,
  jobId: string,
  maxRetries = 3,
  options: { uefi?: boolean; persistent?: boolean; deps?: Partial<IpmiRetryDeps> } = {},
): Promise<LegacyIpmiResult> {
  const bootOptions = { uefi: options.uefi ?? true, persistent: options.persistent ?? true };
  const deps: IpmiRetryDeps = { ...defaultDeps, ...options.deps };

  let lastLegacy: LegacyIpmiResult = { result: 'failure', response: '' };
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    logInfo(`IPMI '${operation}' attempt ${attempt}/${maxRetries}`, { jobId });

    if (!(await deps.ipmiPing(device.ip, { port: device.port, jobId }))) {
      const msg = `IPMI ping failed - IP ${device.ip} is not reachable`;
      logWarning(`IPMI '${operation}' attempt ${attempt} skipped: ${msg}`, { jobId });
      lastLegacy = { result: 'failure', response: msg };
      if (attempt < maxRetries) {
        const backoff = Math.min(4 * 2 ** (attempt - 1), 10);
        await deps.sleep(backoff * 1000);
      }
      continue;
    }

    if (attempt > 1 && IDEMPOTENT_POWER_OPS.includes(operation)) {
      if (!(await deps.shouldExecutePowerOp(device, operation))) {
        const msg = `Server is already in desired power state (${operation})`;
        logInfo(msg, { jobId });
        return { result: 'success', response: msg };
      }
    }

    const result = await dispatchOp(device, operation, bootOptions, deps);
    const legacy = toLegacy(result);
    lastLegacy = legacy;

    if (result.ok) {
      logInfo(`IPMI '${operation}' succeeded on attempt ${attempt}`, { jobId });
      return legacy;
    }

    logWarning(`IPMI '${operation}' attempt ${attempt} failed: ${JSON.stringify(legacy)}`, { jobId });

    if (attempt < maxRetries) {
      const backoff = Math.min(4 * 2 ** (attempt - 1), 10);
      logInfo(`Waiting ${backoff}s before retry`, { jobId });
      await deps.sleep(backoff * 1000);
    }
  }

  logError(`IPMI '${operation}' failed after ${maxRetries} attempts: ${JSON.stringify(lastLegacy)}`, { jobId });
  return lastLegacy;
}
