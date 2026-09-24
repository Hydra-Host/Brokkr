import { getErrorMessage } from '../common/error-utils';
import { RedfishBootHandler, RedfishDevice, RedfishDiscoveryHandler } from '../redfish/index.js';
import type { TeeSetResult, TeeVerificationResult } from '../redfish/vendor/base/tee.js';

import { getLogger } from '../logger/logger.service';

const logInfo = (msg: string, ctx?: { jobId?: string }): void => void getLogger().info(msg, ctx);
const logError = (msg: string, ctx?: { jobId?: string }): void => void getLogger().error(msg, ctx);

export interface RedfishTeeCapableService {
  setTee(device: RedfishDevice, newSetting: boolean): Promise<boolean>;
  verifyTee(device: RedfishDevice): Promise<TeeVerificationResult>;
  reliableBoot(device: RedfishDevice): Promise<unknown>;
}

export type CreateRedfishServiceFn = (jobId: string) => Promise<RedfishTeeCapableService>;

export interface RedfishStandardizeHandlers {
  createDiscoveryHandler: (device: RedfishDevice, jobId: string) => { discover: () => Promise<unknown> };
  createBootHandler: (
    device: RedfishDevice,
    jobId: string,
  ) => { discover: () => Promise<unknown>; reliableBoot: () => Promise<unknown> };
}

export interface RedfishOperationsDeps {
  createRedfishService?: CreateRedfishServiceFn;
  // Missing adapters must throw, not silently no-op: downstream wipe/deploy would run on the wrong security posture.
  standardizeHandlers?: RedfishStandardizeHandlers;
}

export class RedfishServiceUnavailableError extends Error {
  constructor(operation: string) {
    super(`Redfish service not wired — cannot perform '${operation}'. Refusing to silently no-op.`);
    this.name = 'RedfishServiceUnavailableError';
  }
}

function createDevice(
  deviceId: string,
  bmcIp: string,
  username: string,
  password: string,
  jobId: string,
): RedfishDevice {
  return new RedfishDevice(jobId, deviceId, bmcIp, username, password);
}

export async function disableTee(
  deviceId: string,
  bmcIp: string,
  username: string,
  password: string,
  jobId: string,
  deps: RedfishOperationsDeps = {},
): Promise<TeeSetResult> {
  if (deps.createRedfishService === undefined) {
    logError('Redfish service not wired — refusing to silently no-op TEE disable', { jobId });
    throw new RedfishServiceUnavailableError('disableTee');
  }
  let device: RedfishDevice | null = null;
  try {
    device = createDevice(deviceId, bmcIp, username, password, jobId);
    const service = await deps.createRedfishService(jobId);
    const success = await service.setTee(device, false);
    if (success) {
      logInfo('TEE disabled via Redfish', { jobId });
    }
    return { success, hostResetAt: device.lastHostResetAt };
  } catch (e) {
    logError(`Failed to disable TEE via Redfish: ${getErrorMessage(e)}`, { jobId });
    return { success: false, hostResetAt: device?.lastHostResetAt ?? null };
  }
}

export async function enableTee(
  deviceId: string,
  bmcIp: string,
  username: string,
  password: string,
  jobId: string,
  deps: RedfishOperationsDeps = {},
): Promise<TeeSetResult> {
  if (deps.createRedfishService === undefined) {
    logError('Redfish service not wired — refusing to silently no-op TEE enable', { jobId });
    throw new RedfishServiceUnavailableError('enableTee');
  }
  let device: RedfishDevice | null = null;
  try {
    device = createDevice(deviceId, bmcIp, username, password, jobId);
    const service = await deps.createRedfishService(jobId);
    const success = await service.setTee(device, true);
    if (success) {
      logInfo('TEE enabled via Redfish', { jobId });
    }
    return { success, hostResetAt: device.lastHostResetAt };
  } catch (e) {
    logError(`Failed to enable TEE via Redfish: ${getErrorMessage(e)}`, { jobId });
    return { success: false, hostResetAt: device?.lastHostResetAt ?? null };
  }
}

export async function verifyTee(
  deviceId: string,
  bmcIp: string,
  username: string,
  password: string,
  jobId: string,
  deps: RedfishOperationsDeps = {},
): Promise<TeeVerificationResult> {
  if (deps.createRedfishService === undefined) {
    logError('Redfish service not wired — refusing to silently no-op TEE verification', { jobId });
    throw new RedfishServiceUnavailableError('verifyTee');
  }
  try {
    const device = createDevice(deviceId, bmcIp, username, password, jobId);
    const service = await deps.createRedfishService(jobId);
    const result = await service.verifyTee(device);
    logInfo(`TEE verification via Redfish: ${JSON.stringify(result)}`, { jobId });
    return result;
  } catch (error) {
    logError(`Failed to verify TEE via Redfish: ${getErrorMessage(error)}`, { jobId });
    return { ok: false, checked: false, missing: [], reason: 'bmc-unreachable' };
  }
}

export async function disableOsBootOptions(
  deviceId: string,
  bmcIp: string,
  username: string,
  password: string,
  jobId: string,
  deps: RedfishOperationsDeps = {},
): Promise<boolean> {
  if (deps.createRedfishService === undefined) {
    logError('Redfish service not wired — refusing to silently no-op OS boot option disable', { jobId });
    throw new RedfishServiceUnavailableError('disableOsBootOptions');
  }
  try {
    const device = createDevice(deviceId, bmcIp, username, password, jobId);
    const service = await deps.createRedfishService(jobId);
    await service.reliableBoot(device);
    logInfo('OS boot options disabled via Redfish', { jobId });
    return true;
  } catch (e) {
    logError(`Failed to disable OS boot options via Redfish: ${getErrorMessage(e)}`, { jobId });
    return false;
  }
}

const defaultStandardizeHandlers: RedfishStandardizeHandlers = {
  createDiscoveryHandler: (device, jobId) => new RedfishDiscoveryHandler(device, jobId),
  createBootHandler: (device, jobId) => new RedfishBootHandler(device, jobId),
};

export async function redfishStandardize(
  deviceId: string,
  bmcIp: string,
  username: string,
  password: string,
  jobId: string,
  deps: RedfishOperationsDeps = {},
): Promise<Record<string, unknown>> {
  if (deps.standardizeHandlers === undefined && deps.createRedfishService === undefined) {
    logError('Redfish service not wired — refusing to silently no-op BIOS standardization', { jobId });
    throw new RedfishServiceUnavailableError('redfishStandardize');
  }
  const handlers = deps.standardizeHandlers ?? defaultStandardizeHandlers;
  try {
    const device = createDevice(deviceId, bmcIp, username, password, jobId);

    const discovery = handlers.createDiscoveryHandler(device, jobId);
    await discovery.discover();
    const biosParams: Record<string, unknown> = { ...device.biosParams, ...device.biosPendingParams };

    const bootHandler = handlers.createBootHandler(device, jobId);
    await bootHandler.discover();
    await bootHandler.reliableBoot();

    logInfo('Redfish BIOS standardization completed', { jobId });
    return biosParams;
  } catch (e) {
    logError(`Redfish BIOS standardization failed: ${getErrorMessage(e)}`, { jobId });
    throw e;
  }
}
