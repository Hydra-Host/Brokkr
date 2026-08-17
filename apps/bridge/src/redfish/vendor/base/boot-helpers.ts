import { isRecord } from '@repo/utils';

import { asString, type JsonRecord, logger, PropertyAccessError } from './base.js';
import type { RedfishBootHandler } from './boot.js';

const APP_CLASS = 'adapters-redfish';

export async function filterLinkUpEthernetInterfaces(
  handler: RedfishBootHandler,
  parentEndpoint: string,
): Promise<JsonRecord[]> {
  const parentResponse = await handler.fetch('GET', parentEndpoint, {});
  let ethernetInterfaceEndpoint = handler.extractString(parentResponse, 'EthernetInterfaces_@odata.id');
  if (ethernetInterfaceEndpoint === null) {
    logger.info('failed to determine the EthernetInterfaces endpoint', {
      jobId: handler.jobId,
      appClassName: APP_CLASS,
    });
    return [];
  }

  ethernetInterfaceEndpoint += '?$expand=*($levels=1)';
  const ethernetInterfaceResponse = await handler.fetch('GET', ethernetInterfaceEndpoint, {});
  const membersRaw = 'Members' in ethernetInterfaceResponse ? ethernetInterfaceResponse['Members'] : [];
  if (membersRaw === null) {
    throw new PropertyAccessError(`null is not iterable`);
  }
  if (!Array.isArray(membersRaw)) {
    throw new PropertyAccessError(`'${typeof membersRaw}' is not iterable`);
  }
  const results: JsonRecord[] = [];
  for (const iface of membersRaw) {
    if (!isRecord(iface)) {
      throw new PropertyAccessError(`cannot read property 'get' of ${typeof iface}`);
    }
    if (asString(iface['LinkStatus']) === 'LinkUp') {
      results.push(iface);
    }
  }
  return results;
}

/** Deliberately not the vendor-profile default (which stays a no-op) so unmatched brands never get PXE PATCHes. */
export async function patchStandardPxeBootOverride(handler: RedfishBootHandler): Promise<void> {
  await handler.fetch('PATCH', handler.device.systemEndpoint, {
    Boot: {
      BootSourceOverrideTarget: 'Pxe',
      BootSourceOverrideEnabled: 'Continuous',
      BootSourceOverrideMode: 'UEFI',
    },
  });
}
