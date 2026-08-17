import {
  asArray,
  asRecord,
  asString,
  type JsonRecord,
  logger,
  PropertyAccessError,
  RecordKeyError,
  RecordTypeError,
} from '../base/base.js';
import { filterLinkUpEthernetInterfaces } from '../base/boot-helpers.js';
import type { RedfishBootHandler } from '../base/boot.js';
import type { RedfishDiscoveryHandler } from '../base/discovery.js';
import { registerVendorProfile } from '../base/registry.js';
import { BaseVendorProfile } from '../base/vendor-profile.js';

const APP_CLASS = 'adapters-redfish';

/** Cisco CBMC vendor profile. */
export class CiscoVendorProfile extends BaseVendorProfile {
  readonly tagPattern = /^cisco\.cbmc\..*/;
  // Discovery detects the controller (cbmc) inside the walk, so at dispatch the
  // tag is still `cisco..`; match broadly here.
  override readonly discoveryTagPattern = /^cisco.*$/;

  // `response` is the System document discovery already fetched.
  override async discoverSystemInfo(handler: RedfishDiscoveryHandler, response: JsonRecord): Promise<void> {
    handler.device.vendor = 'cisco';
    handler.device.controller = 'cbmc';

    const ciscoModelRaw = 'Model' in response ? response['Model'] : '';
    if (typeof ciscoModelRaw !== 'string') {
      throw new PropertyAccessError(
        `'${ciscoModelRaw === null ? 'null' : typeof ciscoModelRaw}' cannot read property 'toLowerCase' of non-string`,
      );
    }
    handler.device.modelFull = ciscoModelRaw;
    handler.device.model = handler.device.modelFull.toLowerCase().trim();

    handler.device.bootState = asString(response['PowerState']);

    handler.device.rebootEndpoint = handler.extractString(response, 'Actions_#ComputerSystem.Reset_target') ?? '';
    handler.device.managerEndpoint = handler.extractString(response, 'Links_ManagedBy_0_@odata.id') ?? '';
    handler.device.biosGetEndpoint = handler.extractString(response, 'Bios_@odata.id') ?? '';

    let biosResponse: JsonRecord = {};
    if (handler.device.biosGetEndpoint) {
      biosResponse = await handler.fetch('GET', handler.device.biosGetEndpoint, {});
      handler.device.biosParams = asRecord(biosResponse['Attributes']);
      handler.device.biosPatchEndpoint =
        handler.extractString(biosResponse, '@Redfish.Settings_SettingsObject_@odata.id') ?? '';
    } else {
      logger.error('failed to determine the bios endpoint', { jobId: handler.jobId, appClassName: APP_CLASS });
    }

    if ('AttributeRegistry' in biosResponse) {
      const biosRegistryUrl = `/redfish/v1/Registries/${String(biosResponse['AttributeRegistry'])}`;
      let biosRegistryResponse = await handler.fetch('GET', biosRegistryUrl, {});
      if (!('Location' in biosRegistryResponse)) throw new RecordKeyError('Location');
      const ciscoLocations = biosRegistryResponse['Location'];
      if (!Array.isArray(ciscoLocations)) {
        throw new RecordTypeError(
          `'${ciscoLocations === null ? 'null' : typeof ciscoLocations}' object is not iterable`,
        );
      }
      const registryLocation = ciscoLocations.filter((location) =>
        ['en', 'en-US'].includes(asString((location as Record<string, unknown>)?.['Language'])),
      );
      if (registryLocation.length > 0) {
        const uriValue = handler.extractNestedValue(registryLocation, '0_Uri');
        const uri = String(uriValue);
        biosRegistryResponse = await handler.fetch('GET', uri, {});
        handler.device.registry = handler.buildRegistry(
          asArray(handler.extractNestedValue(biosRegistryResponse, 'RegistryEntries_Attributes', '_', [])),
        );
      }
    }
  }

  override findActiveInterfaces(handler: RedfishBootHandler): Promise<JsonRecord[]> {
    return filterLinkUpEthernetInterfaces(handler, handler.device.managerEndpoint);
  }
}

registerVendorProfile(new CiscoVendorProfile());
