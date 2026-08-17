import { isRecord } from '@repo/utils';

import { logger, PropertyAccessError, RecordTypeError, sleep, UninitializedVariableError } from './base.js';
import type { RedfishPowerHandler } from './power.js';

const APP_CLASS = 'adapters-redfish';

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
