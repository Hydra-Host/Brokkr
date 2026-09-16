import { isRecord } from '@repo/utils';

import {
  asArray,
  asRecord,
  asString,
  diffBiosPendingParams,
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
import { pollResetRebootUntilBiosSettled, pollResetRebootWithPendingBios } from '../base/reboot-helpers.js';
import { registerVendorProfile } from '../base/registry.js';
import type { RedfishTeeHandler, TeeBiosCheck } from '../base/tee.js';
import { BaseVendorProfile } from '../base/vendor-profile.js';
import {
  resolveAttributeName,
  resolveSupermicroTee,
  SUPERMICRO_TEE_ATTRIBUTES,
  SUPERMICRO_TEE_VERIFY_IDS,
} from './tee-attributes.js';

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
        // the X14 SD document echoes the whole live map, so only the delta counts as pending
        handler.device.biosPendingParams = diffBiosPendingParams(
          Object.entries(asRecord(biosPatchResponse['Attributes'])),
          handler.device.biosParams,
        );
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
    const { device } = handler;
    const context = { jobId: handler.jobId, appClassName: APP_CLASS };
    if (isEmptyRecord(device.registry)) {
      logger.error('BIOS attribute registry not available for Supermicro TEE configuration', context);
      return false;
    }

    const direction = newSetting ? 'enable' : 'disable';
    const { stages, failures, skipped } = resolveSupermicroTee(device, direction);
    for (const skip of skipped) {
      if (skip.reason === 'hidden') {
        logger.warning(`tee ${direction}: ${skip.detail}; leaving it untouched`, context);
      } else {
        logger.info(`tee ${direction}: ${skip.detail}`, context);
      }
    }
    if (failures.length > 0) {
      const detail = failures.map((failure) => `${failure.id}: ${failure.reason} (${failure.detail})`).join('; ');
      logger.error(`tee ${direction} cannot proceed on ${device.tag()}: ${detail}`, context);
      return false;
    }

    for (const stage of stages) {
      const { ok, patched } = await handler.applyTeeStage(stage);
      if (!ok) {
        logger.error(`tee ${direction}: stage ${Object.keys(stage).join(', ')} failed; later stages skipped`, context);
        return false;
      }
      // ResetRequired is null on this registry, so the fence keys off what was actually patched
      if (patched > 0 || device.rebootNeeded) {
        await pollResetRebootUntilBiosSettled(handler);
      }
    }

    logger.info(`TEE is now ${newSetting ? 'enabled' : 'disabled'}`, context);
    return true;
  }

  override verifyTee(handler: RedfishTeeHandler) {
    const { device } = handler;
    const { resolved } = resolveSupermicroTee(device, 'enable');
    const liveKeys = Object.keys(device.biosParams);
    const checks = SUPERMICRO_TEE_VERIFY_IDS.map((id): TeeBiosCheck => {
      const setting = resolved[id];
      if (setting !== undefined) return ['', setting.key, setting.desired];
      // unresolved in the registry (none loaded, or this id absent or ambiguous there): match the live attribute
      // names with the display-form value only; an unresolvable id keeps names[0] so it reads back as missing
      const attribute = SUPERMICRO_TEE_ATTRIBUTES[id];
      const lookup = resolveAttributeName(attribute, liveKeys, device.displayNameToAttr);
      return ['', 'key' in lookup ? lookup.key : attribute.names[0], [attribute.on]];
    });
    return Promise.resolve(handler.verifyBiosSettings(checks));
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
