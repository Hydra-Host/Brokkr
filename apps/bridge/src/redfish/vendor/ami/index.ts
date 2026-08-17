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
} from '../base/base.js';
import type { RedfishBootHandler } from '../base/boot.js';
import type { RedfishDiscoveryHandler } from '../base/discovery.js';
import { registerVendorProfile } from '../base/registry.js';
import { BaseVendorProfile } from '../base/vendor-profile.js';

const APP_CLASS = 'adapters-redfish';

/** AMI (OpenBMC) vendor profile. */
export class AmiVendorProfile extends BaseVendorProfile {
  readonly tagPattern = /^ami\..*/;

  // `response` is the System document discovery already fetched.
  override async discoverSystemInfo(handler: RedfishDiscoveryHandler, response: JsonRecord): Promise<void> {
    if (handler.device.model === 'unknown') {
      const amiModelRaw = 'Model' in response ? response['Model'] : '';
      if (typeof amiModelRaw !== 'string') {
        throw new PropertyAccessError(
          `'${amiModelRaw === null ? 'null' : typeof amiModelRaw}' cannot read property 'toLowerCase' of non-string`,
        );
      }
      handler.device.modelFull = amiModelRaw;
      handler.device.model = handler.device.modelFull.toLowerCase().trim();
    }

    handler.device.bootState = asString(response['PowerState']);
    const resetActionEndpoint = handler.extractString(response, 'Actions_#ComputerSystem.Reset_@Redfish.ActionInfo');
    if (resetActionEndpoint) {
      const resetActionResponse = await handler.fetch('GET', resetActionEndpoint, {});
      handler.device.bootOptions = handler.extractStringArray(resetActionResponse, 'Parameters_0_AllowableValues');
    } else {
      logger.warning('failed to determine the reboot options endpoint', {
        jobId: handler.jobId,
        appClassName: APP_CLASS,
      });
    }

    handler.device.rebootEndpoint = handler.extractString(response, 'Actions_#ComputerSystem.Reset_target') ?? '';
    if (!handler.device.rebootEndpoint) {
      logger.warning('failed to determine the reboot endpoint', { jobId: handler.jobId, appClassName: APP_CLASS });
    }

    let managerResponse: JsonRecord = {};
    handler.device.managerEndpoint = handler.extractString(response, 'Links_ManagedBy_0_@odata.id') ?? '';
    if (!handler.device.controller && handler.device.managerEndpoint) {
      managerResponse = await handler.fetch('GET', handler.device.managerEndpoint, {});
      const amiControllerRaw = handler.extractNestedValue(managerResponse, 'ManagerType');
      if (amiControllerRaw) {
        if (typeof amiControllerRaw !== 'string') {
          throw new PropertyAccessError(
            `'${typeof amiControllerRaw}' cannot read property 'toLowerCase' of non-string`,
          );
        }
        handler.device.controller = amiControllerRaw.toLowerCase();
      } else {
        handler.device.controller = String(amiControllerRaw);
      }
    } else {
      logger.error('failed to determine the Manager endpoint', { jobId: handler.jobId, appClassName: APP_CLASS });
    }

    if (handler.device.model === '' && 'Model' in managerResponse) {
      const amiModel = managerResponse['Model'];
      if (typeof amiModel !== 'string') {
        throw new PropertyAccessError(`'${typeof amiModel}' cannot read property 'toLowerCase' of non-string`);
      }
      handler.device.model = amiModel.toLowerCase().trim();
    }

    const amiBiosEndpoint = (response['Bios'] as Record<string, unknown> | undefined)?.['@odata.id'];
    handler.device.biosGetEndpoint = typeof amiBiosEndpoint === 'string' ? amiBiosEndpoint : '';
    if (!handler.device.biosGetEndpoint) {
      logger.error('failed to determine the bios endpoint', { jobId: handler.jobId, appClassName: APP_CLASS });
    } else {
      let biosResponse = await handler.fetch('GET', handler.device.biosGetEndpoint, {});
      handler.device.biosParams = asRecord(biosResponse['Attributes']);

      const amiPatchRaw = handler.extractNestedValue(
        biosResponse,
        '@Redfish.Settings_SettingsObject_@odata.id',
        '_',
        '',
      );
      handler.device.biosPatchEndpoint = amiPatchRaw ? String(amiPatchRaw) : '';
      if (handler.device.biosPatchEndpoint) {
        biosResponse = await handler.fetch('GET', handler.device.biosPatchEndpoint, {});
        handler.device.biosPendingParams = asRecord(biosResponse['Attributes']);
        if (!isEmptyRecord(handler.device.biosPendingParams)) {
          handler.device.rebootNeeded = true;
        }
      }

      if ('AttributeRegistry' in biosResponse) {
        const amiAttributeRegistry = String(biosResponse['AttributeRegistry']);
        const biosRegistryResponse = await handler.fetch(
          'GET',
          `/redfish/v1/Registries/${amiAttributeRegistry}.json`,
          {},
        );
        handler.device.registry = handler.buildRegistry(
          asArray(handler.extractNestedValue(biosRegistryResponse, 'RegistryEntries_Attributes', '_', [])),
        );
      }
    }
  }

  override async disableOsBootOptions(handler: RedfishBootHandler): Promise<void> {
    try {
      const systemsResponse = await handler.fetch('GET', '/redfish/v1/Systems', {});
      const systems = asArray(systemsResponse['Members']);
      if (systems.length === 0) {
        logger.error('No systems found', { jobId: handler.jobId, appClassName: APP_CLASS });
        return;
      }

      const sys0 = asRecord(systems[0]);
      if (!('@odata.id' in sys0)) throw new RecordKeyError('@odata.id');
      const systemEndpoint = asString(sys0['@odata.id']);
      const systemResponse = await handler.fetch('GET', systemEndpoint, {});

      const bootOptionsEndpoint = handler.extractString(systemResponse, 'Boot_BootOptions_@odata.id');
      if (!bootOptionsEndpoint) {
        logger.error('BootOptions endpoint not found', { jobId: handler.jobId, appClassName: APP_CLASS });
        return;
      }

      const bootOptionsResponse = await handler.fetch('GET', bootOptionsEndpoint, {});
      const bootOptionRefs = asArray(bootOptionsResponse['Members']);
      if (bootOptionRefs.length === 0) {
        logger.warning('No boot options found', { jobId: handler.jobId, appClassName: APP_CLASS });
        return;
      }

      let disabledCount = 0;

      for (const bootOptionRef of bootOptionRefs) {
        const bootOptRef = asRecord(bootOptionRef);
        if (!('@odata.id' in bootOptRef)) throw new RecordKeyError('@odata.id');
        const bootOptionEndpoint = asString(bootOptRef['@odata.id']);
        const bootOption = await handler.fetch('GET', bootOptionEndpoint, {});

        if (isEmptyRecord(bootOption)) {
          continue;
        }

        let shouldDisable = false;
        const displayNameRaw = 'DisplayName' in bootOption ? bootOption['DisplayName'] : '';
        if (typeof displayNameRaw !== 'string') {
          throw new PropertyAccessError(
            `cannot read property 'toLowerCase' of ${displayNameRaw === null ? 'null' : typeof displayNameRaw}`,
          );
        }
        const displayName = displayNameRaw.toLowerCase();
        const uefiDevicePathRaw = 'UefiDevicePath' in bootOption ? bootOption['UefiDevicePath'] : '';
        if (typeof uefiDevicePathRaw !== 'string') {
          throw new PropertyAccessError(
            `cannot read property 'startsWith' of ${uefiDevicePathRaw === null ? 'null' : typeof uefiDevicePathRaw}`,
          );
        }
        const uefiDevicePath = uefiDevicePathRaw;
        const bootEnabled = !!bootOption['BootOptionEnabled'];

        const nameForLog = 'Name' in bootOption ? String(bootOption['Name']) : 'Unknown';

        if (['ubuntu', 'debian'].includes(displayName)) {
          shouldDisable = true;
          logger.info(`Found OS boot option to disable: ${displayName}`, {
            jobId: handler.jobId,
            appClassName: APP_CLASS,
          });
        } else if (uefiDevicePath.startsWith('HD(')) {
          shouldDisable = true;
          logger.info(`Found HD-based boot option to disable: ${nameForLog}`, {
            jobId: handler.jobId,
            appClassName: APP_CLASS,
          });
        }

        if (shouldDisable && bootEnabled) {
          logger.info(`Disabling boot option ${nameForLog} (${displayName})`, {
            jobId: handler.jobId,
            appClassName: APP_CLASS,
          });

          let settingsEndpoint = bootOptionEndpoint;
          if ('@Redfish.Settings' in bootOption) {
            const settingsObj =
              (bootOption['@Redfish.Settings'] as Record<string, unknown> | undefined)?.['SettingsObject'] ?? {};
            if (isRecord(settingsObj) && '@odata.id' in settingsObj) {
              settingsEndpoint = asString(settingsObj['@odata.id']);
              logger.info(`Using Redfish Settings endpoint: ${settingsEndpoint}`, {
                jobId: handler.jobId,
                appClassName: APP_CLASS,
              });
            }
          }

          const patchResponse = await handler.fetch('PATCH', settingsEndpoint, { BootOptionEnabled: false });

          if (!isEmptyRecord(patchResponse)) {
            disabledCount += 1;
            logger.info(`Successfully disabled boot option: ${nameForLog}`, {
              jobId: handler.jobId,
              appClassName: APP_CLASS,
            });
          } else {
            logger.error(`Failed to disable boot option: ${nameForLog}`, {
              jobId: handler.jobId,
              appClassName: APP_CLASS,
            });
          }
        } else if (shouldDisable && !bootEnabled) {
          logger.info(`Boot option ${nameForLog} already disabled`, {
            jobId: handler.jobId,
            appClassName: APP_CLASS,
          });
        }
      }

      logger.info(`OS boot options processing complete: ${disabledCount} options disabled`, {
        jobId: handler.jobId,
        appClassName: APP_CLASS,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Error during OS boot option processing: ${message}`, {
        jobId: handler.jobId,
        appClassName: APP_CLASS,
      });
    }
  }
}

registerVendorProfile(new AmiVendorProfile());
