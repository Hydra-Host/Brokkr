import { isRecord } from '@repo/utils';
import {
  asArray,
  asRecord,
  asString,
  isEmptyRecord,
  JsonRecord,
  logger,
  PropertyAccessError,
  RecordKeyError,
  RedfishBaseHandler,
} from './base.js';
// Side-effect import guarantees every brand VendorProfile is registered before
// discovery resolves one (mirrors the other generic handlers).
import './register-brands.js';
import { resolveVendorProfileForDiscovery } from './registry.js';

const APP_CLASS = 'adapters-redfish';

export class RedfishDiscoveryHandler extends RedfishBaseHandler {
  async discover(): Promise<void> {
    // Catch every exception (incl PropertyAccessError from non-dict bodies)
    // and fall back to /redfish/v1 so a misbehaving BMC root still proceeds.
    try {
      const response = await this.fetch('GET', '/redfish', {});
      if (isEmptyRecord(response)) {
        logger.warning('No response from /redfish endpoint - BMC may not support Redfish', {
          jobId: this.jobId,
          appClassName: APP_CLASS,
        });
        return;
      }

      this.device.redfishEndpoint = asString(response['v1']);
      if (!this.device.redfishEndpoint) {
        logger.warning('No v1 endpoint in /redfish response, trying /redfish/v1', {
          jobId: this.jobId,
          appClassName: APP_CLASS,
        });
        this.device.redfishEndpoint = '/redfish/v1';
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warning(`Exception during /redfish discovery: ${message}, trying /redfish/v1`, {
        jobId: this.jobId,
        appClassName: APP_CLASS,
      });
      this.device.redfishEndpoint = '/redfish/v1';
    }

    if (!this.device.redfishEndpoint) {
      logger.error('Failed to determine Redfish endpoint', { jobId: this.jobId, appClassName: APP_CLASS });
      return;
    }

    let rootResponse = await this.fetch('GET', this.device.redfishEndpoint, {});
    if (isEmptyRecord(rootResponse) && !this.device.redfishEndpoint.endsWith('/')) {
      logger.warning(`No response from ${this.device.redfishEndpoint}, trying with trailing slash`, {
        jobId: this.jobId,
        appClassName: APP_CLASS,
      });
      this.device.redfishEndpoint += '/';
      rootResponse = await this.fetch('GET', this.device.redfishEndpoint, {});
    }

    if (isEmptyRecord(rootResponse)) {
      logger.error('Failed to connect to Redfish service', { jobId: this.jobId, appClassName: APP_CLASS });
      this.device.redfishEndpoint = '';
      return;
    }

    let vendorRaw: unknown = 'Vendor' in rootResponse ? rootResponse['Vendor'] : '';
    if (!vendorRaw) {
      vendorRaw = 'Manufacturer' in rootResponse ? rootResponse['Manufacturer'] : '';
    }
    if (!vendorRaw) {
      const oemRaw = 'Oem' in rootResponse ? rootResponse['Oem'] : {};
      if (!isRecord(oemRaw)) {
        throw new PropertyAccessError(
          `'${oemRaw === null ? 'null' : typeof oemRaw}' cannot read property 'keys' of non-object`,
        );
      }
      const oemKeys = Object.keys(oemRaw);
      if (oemKeys.length > 0) {
        vendorRaw = oemKeys[0] ?? '';
      }
    }
    if (typeof vendorRaw !== 'string') {
      throw new PropertyAccessError(
        `'${vendorRaw === null ? 'null' : typeof vendorRaw}' cannot read property 'trim' of non-string`,
      );
    }
    this.device.vendor = vendorRaw.trim().toLowerCase();
    if (this.device.vendor === 'public') {
      const publicManufacturer = this.extractString(rootResponse, 'Oem_Public_Manufacturer');
      if (publicManufacturer === null) {
        throw new PropertyAccessError(`'null' cannot read property 'toLowerCase' of non-string`);
      }
      this.device.vendor = publicManufacturer.toLowerCase();
    }
    if (!this.device.vendor) {
      logger.warning('failed to determine the vendor', { jobId: this.jobId, appClassName: APP_CLASS });
      this.device.vendor = 'null';
    }

    const systemsEndpointRaw = (rootResponse['Systems'] as Record<string, unknown> | undefined)?.['@odata.id'];
    const systemsEndpoint = typeof systemsEndpointRaw === 'string' ? systemsEndpointRaw : '';
    if (systemsEndpoint) {
      const systemResponse = await this.fetch('GET', systemsEndpoint, {});
      const systemEndpoint = this.extractString(systemResponse, 'Members_0_@odata.id');
      this.device.systemEndpoint = systemEndpoint ?? '';
      if (systemEndpoint === null) {
        logger.error('failed to determine the System endpoint', { jobId: this.jobId, appClassName: APP_CLASS });
      }
    }

    const jobserviceMainEndpoint = this.extractString(rootResponse, 'JobService_@odata.id');
    if (jobserviceMainEndpoint) {
      const jobserviceResponse = await this.fetch('GET', jobserviceMainEndpoint, {});
      this.device.jobserviceEndpoint = this.extractString(jobserviceResponse, 'Jobs_@odata.id') ?? '';
    }

    this.device.accountserviceEndpoint = this.extractString(rootResponse, 'AccountService_@odata.id') ?? '';
    this.device.registriesEndpoint = this.extractString(rootResponse, 'Registries_@odata.id') ?? '';
    this.device.securebootEndpoint = this.extractString(rootResponse, 'SecureBoot_@odata.id') ?? '';
    this.device.storageEndpoint = this.extractString(rootResponse, 'Storage_@odata.id') ?? '';

    if (this.device.systemEndpoint) {
      await this.getSystemInfo();
    }

    logger.info(`discovered device: ${this.device.tag()}`, { jobId: this.jobId, appClassName: APP_CLASS });

    if (isEmptyRecord(this.device.registry)) {
      logger.info('failed to determine the BIOS parameter registry', { jobId: this.jobId, appClassName: APP_CLASS });
    }

    if (this.device.rebootNeeded) {
      logger.warning('there are pending BIOS settings that require a reboot to take effect', {
        jobId: this.jobId,
        appClassName: APP_CLASS,
      });
    }
  }

  /** @internal Public so the aivres discovery profile can reuse the Manager-OEM model fallback. */
  async fallbackModelFromManagerOem(): Promise<void> {
    if (this.device.model !== '') return;
    if (!this.device.managerEndpoint) return;
    const managerResponse = await this.fetch('GET', this.device.managerEndpoint, {});
    if (!('Oem' in managerResponse)) return;
    const oemValue = managerResponse['Oem'];
    if (!isRecord(oemValue)) {
      throw new PropertyAccessError(
        `'${oemValue === null ? 'null' : typeof oemValue}' cannot read property 'keys' of non-object`,
      );
    }
    const oemKeys = Object.keys(oemValue).filter(
      (key) => !['@odata.id', '@odata.type', 'public'].includes(key.toLowerCase()),
    );
    const first = oemKeys[0];
    if (first !== undefined) {
      this.device.model = first.trim().toLowerCase();
    }
  }

  /** @internal Public so brand discovery profiles (vendor/<brand>/) can build the BIOS registry map. */
  buildRegistry(entries: unknown[], nameKey = 'AttributeName'): Record<string, JsonRecord> {
    const registry: Record<string, JsonRecord> = {};
    for (const item of entries) {
      const rec = item as Record<string, unknown>;
      if (!rec || typeof rec !== 'object' || !(nameKey in rec)) throw new RecordKeyError(nameKey);
      const name = String(rec[nameKey]);
      registry[name] = item as JsonRecord;
    }
    return registry;
  }

  async getSystemInfo(): Promise<void> {
    const response = await this.fetch('GET', this.device.systemEndpoint, {});

    if (this.device.tag() === 'aivres..') {
      const aivresModelRaw = 'Model' in response ? response['Model'] : '';
      if (typeof aivresModelRaw !== 'string') {
        throw new PropertyAccessError(
          `'${aivresModelRaw === null ? 'null' : typeof aivresModelRaw}' cannot read property 'trim' of non-string`,
        );
      }
      this.device.modelFull = aivresModelRaw.trim();
      this.device.model = this.device.modelFull.toLowerCase();

      this.device.managerEndpoint = this.extractString(response, 'Links_ManagedBy_0_@odata.id') ?? '';
      if (this.device.managerEndpoint) {
        const managerResponse = await this.fetch('GET', this.device.managerEndpoint, {});
        // Truthy non-string crashes on `.lower()`; falsy values (incl [] / {})
        // fall through and are str-rendered into the tag.
        const extractedRaw = this.extractNestedValue(managerResponse, 'Model');
        if (extractedRaw) {
          if (typeof extractedRaw !== 'string') {
            throw new PropertyAccessError(`'${typeof extractedRaw}' cannot read property 'toLowerCase' of non-string`);
          }
          this.device.controller = extractedRaw.toLowerCase().trim().replaceAll(' ', '');
        } else {
          this.device.controller = String(extractedRaw);
        }
      } else {
        logger.error('failed to determine the Manager endpoint', { jobId: this.jobId, appClassName: APP_CLASS });
      }
    }

    if (this.device.tag() === 'null..') {
      this.device.vendor = 'unknown';
      this.device.controller = 'unknown';
      this.device.model = 'unknown';

      const manufacturerRaw = 'Manufacturer' in response ? response['Manufacturer'] : '';
      if (manufacturerRaw) {
        if (typeof manufacturerRaw !== 'string') {
          throw new PropertyAccessError(`'${typeof manufacturerRaw}' cannot read property 'toLowerCase' of non-string`);
        }
        this.device.vendor = manufacturerRaw.toLowerCase().trim();
      }

      const modelRaw = 'Model' in response ? response['Model'] : '';
      const partNumberRaw = 'PartNumber' in response ? response['PartNumber'] : '';
      if (modelRaw) {
        if (typeof modelRaw !== 'string') {
          throw new PropertyAccessError(`'${typeof modelRaw}' cannot read property 'toLowerCase' of non-string`);
        }
        this.device.model = modelRaw.toLowerCase().trim();
      } else if (partNumberRaw) {
        if (typeof partNumberRaw !== 'string') {
          throw new PropertyAccessError(`'${typeof partNumberRaw}' cannot read property 'toLowerCase' of non-string`);
        }
        this.device.model = partNumberRaw.toLowerCase().trim();
      }
      this.device.model = this.device.model.replaceAll(' ', '');

      this.device.bootState = asString(response['PowerState']);
      this.device.bootOptions = this.extractStringArray(
        response,
        'Actions_#ComputerSystem.Reset_ResetType@Redfish.AllowableValues',
      );
      this.device.rebootEndpoint = this.extractString(response, 'Actions_#ComputerSystem.Reset_target') ?? '';

      this.device.managerEndpoint = this.extractString(response, 'Links_ManagedBy_0_@odata.id') ?? '';
      if (this.device.managerEndpoint) {
        const managerResponse = await this.fetch('GET', this.device.managerEndpoint, {});
        if ('Model' in managerResponse) {
          const nullModel = managerResponse['Model'];
          if (typeof nullModel !== 'string') {
            throw new PropertyAccessError(`'${typeof nullModel}' cannot read property 'toLowerCase' of non-string`);
          }
          this.device.controller = nullModel.toLowerCase().trim().replaceAll(' ', '');
        }
      } else {
        logger.error('failed to determine the Manager endpoint', { jobId: this.jobId, appClassName: APP_CLASS });
      }

      const nullBiosEndpoint = (response['Bios'] as Record<string, unknown> | undefined)?.['@odata.id'];
      this.device.biosGetEndpoint = typeof nullBiosEndpoint === 'string' ? nullBiosEndpoint : '';
      if (!this.device.biosGetEndpoint) {
        logger.error('failed to determine the bios endpoint', { jobId: this.jobId, appClassName: APP_CLASS });
      } else {
        let biosResponse = await this.fetch('GET', this.device.biosGetEndpoint, {});
        this.device.biosParams = asRecord(biosResponse['Attributes']);

        if ('AMITSESetup' in this.device.biosParams) {
          this.device.vendor = 'ami';
        }

        if ('IntelSetup' in this.device.biosParams) {
          this.device.model = 'intel';
        }

        this.device.biosPatchEndpoint =
          this.extractString(biosResponse, '@Redfish.Settings_SettingsObject_@odata.id') ?? '';
        if (this.device.biosPatchEndpoint) {
          biosResponse = await this.fetch('GET', this.device.biosPatchEndpoint, {});
          this.device.biosPendingParams = asRecord(biosResponse['Attributes']);
          if (!isEmptyRecord(this.device.biosPendingParams)) {
            this.device.rebootNeeded = true;
          }
        }

        if ('AttributeRegistry' in biosResponse) {
          const nullAttributeRegistry = String(biosResponse['AttributeRegistry']);
          const biosRegistryResponse = await this.fetch(
            'GET',
            `/redfish/v1/Registries/${nullAttributeRegistry}.json`,
            {},
          );
          this.device.registry = this.buildRegistry(
            asArray(this.extractNestedValue(biosRegistryResponse, 'RegistryEntries_Attributes', '_', [])),
          );
        }
      }
    }

    const tag = this.device.tag();

    await resolveVendorProfileForDiscovery(tag).discoverSystemInfo(this, response);
  }
}
