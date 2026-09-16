import { isRecord } from '@repo/utils';

import type { JsonRecord } from './base.js';
import {
  asRecord,
  diffBiosPendingParams,
  isEmptyRecord,
  logger,
  PropertyAccessError,
  RecordTypeError,
  sleep,
  UninitializedVariableError,
} from './base.js';
import type { RedfishPowerHandler } from './power.js';

const APP_CLASS = 'adapters-redfish';

export class BiosSettleTimeoutError extends Error {
  constructor(message: string) {
    super(`BiosSettleTimeoutError: ${message}`);
    this.name = 'BiosSettleTimeoutError';
  }
}

/** Settled means the pending (`SD`) document no longer differs from the live one, which holds both
 *  for an empty `SD` (X13) and for an `SD` that echoes the full live attribute map (X14). */
export async function pollResetRebootUntilBiosSettled(handler: RedfishPowerHandler): Promise<void> {
  const { device } = handler;
  const payload = { ResetType: device.bootState === 'Off' ? 'On' : 'ForceRestart' };
  await handler.fetch('POST', device.rebootEndpoint, payload);

  let pending: JsonRecord = {};
  for (let i = 0; i < device.rebootWaits; i++) {
    const live = asRecord((await handler.fetch('GET', device.biosGetEndpoint, {}))['Attributes']);
    const scheduled = asRecord((await handler.fetch('GET', device.biosPatchEndpoint, {}))['Attributes']);
    if (isEmptyRecord(live)) {
      logger.info('bios attributes are not readable yet', { jobId: handler.jobId, appClassName: APP_CLASS });
    } else {
      pending = diffBiosPendingParams(Object.entries(scheduled), live);
      if (isEmptyRecord(pending)) {
        device.biosParams = live;
        device.biosPendingParams = pending;
        device.rebootNeeded = false;
        return;
      }
      logger.info(`bios changes are still pending: ${Object.keys(pending).join(', ')}`, {
        jobId: handler.jobId,
        appClassName: APP_CLASS,
      });
    }
    await sleep(device.rebootTimeout * 1000);
  }

  const budgetS = device.rebootWaits * device.rebootTimeout;
  const keys = Object.keys(pending);
  throw new BiosSettleTimeoutError(
    keys.length === 0
      ? `bios attributes were not readable within ${budgetS}s of the reset`
      : `bios changes still pending after ${budgetS}s: ${keys.join(', ')}`,
  );
}

export async function pollResetRebootWithPendingBios(handler: RedfishPowerHandler): Promise<void> {
  const payload = { ResetType: handler.device.bootState === 'Off' ? 'On' : 'ForceRestart' };
  await handler.fetch('POST', handler.device.rebootEndpoint, payload);

  for (let i = 0; i < handler.device.rebootWaits; i++) {
    const response = await handler.fetch('GET', handler.device.chassisEndpoint, {});
    const powerStateRaw = 'PowerState' in response ? response['PowerState'] : '';
    if (typeof powerStateRaw !== 'string') {
      throw new PropertyAccessError(
        `cannot read property 'toLowerCase' of ${powerStateRaw === null ? 'null' : typeof powerStateRaw}`,
      );
    }
    if (powerStateRaw.toLowerCase() === 'on') {
      break;
    }
    await sleep(handler.device.rebootTimeout * 1000);
    logger.info('device is still booting', { jobId: handler.jobId, appClassName: APP_CLASS });
  }

  // If rebootWaits is 0, pendingBiosParams is never assigned; guard
  // against use-before-assignment by tracking binding explicitly.
  let pendingBiosParamsBound = false;
  let pendingBiosParams = false;
  for (let i = 0; i < handler.device.rebootWaits; i++) {
    const pendingBios = await handler.fetch('GET', handler.device.biosPatchEndpoint, {});
    const attributesRaw = 'Attributes' in pendingBios ? pendingBios['Attributes'] : {};
    if (attributesRaw === null) {
      throw new PropertyAccessError(`cannot get length of null`);
    }
    let attributesLen: number;
    if (Array.isArray(attributesRaw)) {
      attributesLen = attributesRaw.length;
    } else if (typeof attributesRaw === 'string') {
      attributesLen = attributesRaw.length;
    } else if (isRecord(attributesRaw)) {
      attributesLen = Object.keys(attributesRaw).length;
    } else {
      throw new RecordTypeError(`cannot get length of '${typeof attributesRaw}'`);
    }
    pendingBiosParams = attributesLen !== 0;
    pendingBiosParamsBound = true;
    if (!pendingBiosParams) {
      handler.device.rebootNeeded = false;
      return;
    }

    logger.info('bios changes are still pending', { jobId: handler.jobId, appClassName: APP_CLASS });
    await sleep(handler.device.rebootTimeout * 1000);
  }

  if (!pendingBiosParamsBound) {
    throw new UninitializedVariableError(
      "UninitializedVariableError: variable 'pending_bios_params' used before assignment",
    );
  }
}
