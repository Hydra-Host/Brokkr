import { isRecord } from '@repo/utils';

import {
  asArray,
  asRecord,
  asString,
  isEmptyRecord,
  type JsonRecord,
  logger,
  PropertyAccessError,
  RecordKeyError,
  RecordTypeError,
} from '../base/base.js';
import { patchStandardPxeBootOverride } from '../base/boot-helpers.js';
import type { RedfishBootHandler } from '../base/boot.js';
import type { RedfishDiscoveryHandler } from '../base/discovery.js';
import type { RedfishPowerHandler } from '../base/power.js';
import { pollResetRebootWithPendingBios } from '../base/reboot-helpers.js';
import { registerVendorProfile } from '../base/registry.js';
import type { RedfishTeeHandler } from '../base/tee.js';
import { BaseVendorProfile } from '../base/vendor-profile.js';

const APP_CLASS = 'adapters-redfish';

/** Supermicro vendor profile. */
export class SupermicroVendorProfile extends BaseVendorProfile {
  readonly tagPattern = /^supermicro\..*/;

  // `response` is discovery's already-fetched System document; this branch additionally
  // re-fetches its own `systemResponse`.
  override async discoverSystemInfo(handler: RedfishDiscoveryHandler, response: JsonRecord): Promise<void> {
    const systemResponse = await handler.fetch('GET', handler.device.systemEndpoint, {});
    const supermicroModel = 'Model' in systemResponse ? systemResponse['Model'] : '';
    if (typeof supermicroModel !== 'string') {
      throw new PropertyAccessError(`'${typeof supermicroModel}' cannot read property 'split' of non-string`);
    }
    handler.device.modelFull = supermicroModel;
    const modelParts = handler.device.modelFull.split('-');
    if (modelParts.length > 3) {
      handler.device.modelFull = modelParts.slice(0, 3).join('-');
    }
    handler.device.model = handler.device.modelFull.toLowerCase().trim().replaceAll(' ', '');

    handler.device.bootState = asString(response['PowerState']);
    handler.device.bootOptions = handler.extractStringArray(
      response,
      'Actions_#ComputerSystem.Reset_ResetType@Redfish.AllowableValues',
    );
    handler.device.rebootEndpoint = handler.extractString(response, 'Actions_#ComputerSystem.Reset_target') ?? '';
    const supermicroManagerEndpoint = handler.extractString(response, 'Links_ManagedBy_0_@odata.id');
    handler.device.managerEndpoint = supermicroManagerEndpoint ?? '';

    const managerResponse = await handler.fetch('GET', handler.device.managerEndpoint, {});
    const supermicroManagerModelRaw = 'Model' in managerResponse ? managerResponse['Model'] : '';
    if (typeof supermicroManagerModelRaw !== 'string') {
      throw new PropertyAccessError(
        `'${typeof supermicroManagerModelRaw}' cannot read property 'toLowerCase' of non-string`,
      );
    }
    handler.device.controller = supermicroManagerModelRaw.toLowerCase().trim();

    const supermicroManagerBios = (managerResponse['Bios'] as Record<string, unknown> | undefined)?.['@odata.id'];
    handler.device.biosGetEndpoint = typeof supermicroManagerBios === 'string' ? supermicroManagerBios : '';
    if (!handler.device.biosGetEndpoint) {
      const supermicroSystemBios = (systemResponse['Bios'] as Record<string, unknown> | undefined)?.['@odata.id'];
      handler.device.biosGetEndpoint = typeof supermicroSystemBios === 'string' ? supermicroSystemBios : '';
    }

    if (handler.device.biosGetEndpoint) {
      const biosResponse = await handler.fetch('GET', handler.device.biosGetEndpoint, {});
      handler.device.biosParams = asRecord(biosResponse['Attributes']);
      handler.device.biosPatchEndpoint =
        handler.extractString(biosResponse, '@Redfish.Settings_SettingsObject_@odata.id') ?? '';
      if (handler.device.biosPatchEndpoint) {
        const biosPatchResponse = await handler.fetch('GET', handler.device.biosPatchEndpoint, {});
        handler.device.biosPendingParams = asRecord(biosPatchResponse['Attributes']);
        if (!isEmptyRecord(handler.device.biosPendingParams)) {
          handler.device.rebootNeeded = true;
        }
      }
    }

    if (handler.device.registriesEndpoint) {
      const registriesResponse = await handler.fetch('GET', handler.device.registriesEndpoint, {});
      if (!('Members' in registriesResponse)) throw new RecordKeyError('Members');
      const supermicroMembers = registriesResponse['Members'];
      if (!Array.isArray(supermicroMembers)) {
        throw new RecordTypeError(
          `'${supermicroMembers === null ? 'null' : typeof supermicroMembers}' object is not iterable`,
        );
      }
      const attributesEndpoints: string[] = [];
      for (const item of supermicroMembers) {
        if (!isRecord(item) || !('@odata.id' in item)) throw new RecordKeyError('@odata.id');
        const odataId = item['@odata.id'];
        if (typeof odataId !== 'string') {
          throw new PropertyAccessError(`argument of type '${typeof odataId}' is not iterable`);
        }
        if (odataId.includes('BiosAttributeRegistry')) {
          attributesEndpoints.push(odataId);
        }
      }
      const biosRegistryEndpoint = attributesEndpoints[0];
      if (biosRegistryEndpoint !== undefined) {
        const attributesResponse = await handler.fetch('GET', biosRegistryEndpoint, {});
        // Only explicit-null Location skips entirely; missing → [] still
        // enters the block where the extractor will miss and yield null.
        const locRaw = 'Location' in attributesResponse ? attributesResponse['Location'] : [];
        if (locRaw !== null) {
          const uriValue = handler.extractNestedValue(locRaw, '0_Uri');
          const uri = String(uriValue);
          const biosRegistryResponse = await handler.fetch('GET', uri, {});
          const registryEntries = asArray(
            handler.extractNestedValue(biosRegistryResponse, 'RegistryEntries_Attributes', '_', []),
          );
          handler.device.registry = handler.buildRegistry(registryEntries);
          const displayNameToAttr: Record<string, string> = {};
          for (const item of registryEntries) {
            if (!isRecord(item)) {
              throw new PropertyAccessError(
                `'${item === null ? 'null' : typeof item}' cannot read properties of non-object`,
              );
            }
            const displayNameRaw = item['DisplayName'];
            if (!displayNameRaw) continue;
            if (!('DisplayName' in item)) throw new RecordKeyError('DisplayName');
            const dn = String(item['DisplayName']);
            if (!('AttributeName' in item)) throw new RecordKeyError('AttributeName');
            const an = String(item['AttributeName']);
            displayNameToAttr[dn] = an;
          }
          handler.device.displayNameToAttr = displayNameToAttr;
        }
      }
    }
  }

  override reboot(handler: RedfishPowerHandler): Promise<void> {
    return pollResetRebootWithPendingBios(handler);
  }

  override async setTee(handler: RedfishTeeHandler, newSetting: boolean): Promise<boolean> {
    // displayNameToAttr is set only on the supermicro discovery path;
    // unset (never-discovered) is a different error than empty.
    if (handler.device.displayNameToAttr === undefined) {
      throw new PropertyAccessError(`'RedfishDevice' cannot read property 'displayNameToAttr' of undefined`);
    }
    if (isEmptyRecord(handler.device.displayNameToAttr)) {
      logger.error('BIOS attribute registry not available for Supermicro TDX configuration', {
        jobId: handler.jobId,
        appClassName: APP_CLASS,
      });
      return false;
    }

    if (newSetting) {
      await handler.applySequentialBiosSettings({
        LimitCPUPAto46Bits: 'Disable',
        MemoryEncryption_TME_: 'Enabled',
      });
      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }

      await handler.applySequentialBiosSettings({
        TotalMemoryEncryptionMulti_Tenant_TME_MT_: 'Enabled',
        TotalMemoryEncryption_TME_Bypass: 'Enabled',
      });
      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }

      await handler.applySequentialBiosSettings({
        TrustDomainExtension_TDX_: 'Enabled',
        TDXSecureArbitrationModeLoader_SEAMLoader_: 'Enabled',
      });
      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }

      await handler.applySequentialBiosSettings({
        TME_MT_TDXKeySplit: 1,
        SWGuardExtensions_SGX_: 'Enabled',
        SGXPackageInfoIn_BandAccess: 'Enabled',
      });
      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }

      await handler.setBiosParam('SGXFactoryReset', 'Enabled');
      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }
    } else {
      await handler.applySequentialBiosSettings({
        SGXPackageInfoIn_BandAccess: 'Disable',
        SWGuardExtensions_SGX_: 'Disable',
        SGXFactoryReset: 'Disable',
      });
      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }

      await handler.applySequentialBiosSettings({
        TDXSecureArbitrationModeLoader_SEAMLoader_: 'Disable',
        TotalMemoryEncryption_TME_Bypass_: 'Disable',
        TrustDomainExtension_TDX_: 'Disable',
        TotalMemoryEncryptionMulti_Tenant_TME_MT_: 'Disable',
      });
      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }

      await handler.setBiosParam('MemoryEncryption_TME_', 'Disable');
      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }

      await handler.setBiosParam('LimitCPUPAto46Bits', 'Enable');
      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }
    }

    logger.info(`TEE is now ${newSetting ? 'enabled' : 'disabled'}`, {
      jobId: handler.jobId,
      appClassName: APP_CLASS,
    });
    return true;
  }

  override verifyTee(handler: RedfishTeeHandler) {
    return Promise.resolve(
      handler.verifyBiosSettings([
        ['', 'MemoryEncryption_TME_', ['Enabled']],
        ['', 'TotalMemoryEncryptionMulti_Tenant_TME_MT_', ['Enabled']],
        ['', 'TrustDomainExtension_TDX_', ['Enabled']],
        ['', 'TDXSecureArbitrationModeLoader_SEAMLoader_', ['Enabled']],
        ['', 'SWGuardExtensions_SGX_', ['Enabled']],
      ]),
    );
  }

  override setBootPxe(handler: RedfishBootHandler): Promise<void> {
    return patchStandardPxeBootOverride(handler);
  }

  // BIOS enum-vocabulary quirk: Supermicro registries accept ValueDisplayName in
  // addition to ValueName.
  override normalizeEnumValues(valueNames: unknown[], values: unknown[]): unknown[] {
    return [...valueNames, ...values.map((item) => (item as Record<string, unknown>)?.['ValueDisplayName'])];
  }
}

registerVendorProfile(new SupermicroVendorProfile());
