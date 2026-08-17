import { isRecord } from '@repo/utils';

import {
  asArray,
  asString,
  diffBiosPendingParams,
  type JsonRecord,
  logger,
  PropertyAccessError,
  RecordKeyError,
  RecordTypeError,
} from '../base/base.js';
import type { RedfishDiscoveryHandler } from '../base/discovery.js';
import { registerVendorProfile } from '../base/registry.js';
import { BaseVendorProfile } from '../base/vendor-profile.js';

const APP_CLASS = 'adapters-redfish';

/** HP (iLO) vendor profile. */
export class HpVendorProfile extends BaseVendorProfile {
  readonly tagPattern = /^hp\..*/;

  // `response` is the System document discovery already fetched.
  override async discoverSystemInfo(handler: RedfishDiscoveryHandler, response: JsonRecord): Promise<void> {
    const hpModelRaw = 'Model' in response ? response['Model'] : '';
    if (typeof hpModelRaw !== 'string') {
      throw new PropertyAccessError(`expected string, got '${hpModelRaw === null ? 'null' : typeof hpModelRaw}'`);
    }
    handler.device.modelFull = hpModelRaw;
    const modelMatch = /^(\S+)\s+(\S+)\s+(\S+)$/.exec(handler.device.modelFull);
    if (modelMatch) {
      handler.device.model = modelMatch[2] ?? '';
    }

    handler.device.bootState = handler.extractString(response, 'Oem_Hp_PostState') ?? '';
    handler.device.bootOptions = handler.extractStringArray(
      response,
      'Actions_#ComputerSystem.Reset_ResetType@Redfish.AllowableValues',
    );
    handler.device.rebootEndpoint = handler.extractString(response, 'Actions_#ComputerSystem.Reset_target') ?? '';

    handler.device.managerEndpoint = handler.extractString(response, 'links_ManagedBy_0_href') ?? '';
    if (!handler.device.managerEndpoint) {
      logger.error('failed to determine the Manager endpoint', { jobId: handler.jobId, appClassName: APP_CLASS });
    }

    handler.device.biosGetEndpoint = handler.extractString(response, 'Oem_Hp_links_BIOS_href') ?? '';
    if (handler.device.biosGetEndpoint) {
      const biosResponse = await handler.fetch('GET', handler.device.biosGetEndpoint, {});
      handler.device.biosParams = biosResponse;
      handler.device.biosPatchEndpoint = handler.extractString(biosResponse, 'links_Settings_href') ?? '';
    } else {
      logger.error('failed to determine the bios endpoint', { jobId: handler.jobId, appClassName: APP_CLASS });
    }

    if ('AttributeRegistry' in handler.device.biosParams) {
      const biosRegistryUrl = `/redfish/v1/Registries/${String(handler.device.biosParams['AttributeRegistry'])}/`;
      let biosRegistryResponse = await handler.fetch('GET', biosRegistryUrl, {});
      if (!('Location' in biosRegistryResponse)) throw new RecordKeyError('Location');
      const hpLocations = biosRegistryResponse['Location'];
      if (!Array.isArray(hpLocations)) {
        throw new RecordTypeError(`'${hpLocations === null ? 'null' : typeof hpLocations}' object is not iterable`);
      }
      const registryLocation = hpLocations.filter(
        (location) => asString((location as Record<string, unknown>)?.['Language']) === 'en',
      );
      if (registryLocation.length > 0) {
        const hpUriValue = handler.extractNestedValue(registryLocation, '0_Uri_extref');
        const hpUri = String(hpUriValue);
        biosRegistryResponse = await handler.fetch('GET', hpUri, {});
        handler.device.registry = handler.buildRegistry(
          asArray(handler.extractNestedValue(biosRegistryResponse, 'RegistryEntries_Attributes', '_', [])),
          'Name',
        );
      }
    }

    if (handler.device.biosPatchEndpoint) {
      const pendingBiosResponse = await handler.fetch('GET', handler.device.biosPatchEndpoint, {});
      handler.device.biosPendingParams = diffBiosPendingParams(
        Object.entries(pendingBiosResponse),
        handler.device.biosParams,
      );
    }

    if (!('Oem' in response)) throw new RecordKeyError('Oem');
    const hpRoot = response['Oem'];
    if (!isRecord(hpRoot) || !('Hp' in hpRoot)) throw new RecordKeyError('Hp');
    const hpOem = hpRoot['Hp'];
    if (!isRecord(hpOem)) {
      throw new PropertyAccessError(`argument of type '${typeof hpOem}' is not iterable`);
    }
    if ('Manager' in hpOem) {
      const hpControllerRaw = handler.extractNestedValue(response, 'Oem_Hp_Manager_0_ManagerType');
      if (hpControllerRaw) {
        if (typeof hpControllerRaw !== 'string') {
          throw new PropertyAccessError(`'${typeof hpControllerRaw}' cannot read property 'toLowerCase' of non-string`);
        }
        handler.device.controller = hpControllerRaw.toLowerCase().replaceAll(' ', '');
      } else {
        handler.device.controller = String(hpControllerRaw);
      }
    } else if (handler.device.managerEndpoint) {
      const managerResponse = await handler.fetch('GET', handler.device.managerEndpoint, {});
      if (!('FirmwareVersion' in managerResponse)) throw new RecordKeyError('FirmwareVersion');
      const firmwareVersion = managerResponse['FirmwareVersion'];
      if (typeof firmwareVersion !== 'string') {
        throw new PropertyAccessError(`'${typeof firmwareVersion}' cannot read property 'split' of non-string`);
      }
      handler.device.controller = firmwareVersion.split(' ').slice(0, 2).join('').toLowerCase();
    }
  }
}

registerVendorProfile(new HpVendorProfile());
