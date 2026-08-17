import { isRecord } from '@repo/utils';

import {
  asArray,
  asRecord,
  asString,
  diffBiosPendingParams,
  escapeRegExp,
  isEmptyRecord,
  type JsonRecord,
  logger,
  PropertyAccessError,
  RecordKeyError,
  RecordTypeError,
  redfishBoolMatches,
  sleep,
} from '../base/base.js';
import type { RedfishBootHandler } from '../base/boot.js';
import type { RedfishDiscoveryHandler } from '../base/discovery.js';
import type { RedfishPowerHandler } from '../base/power.js';
import { registerVendorProfile } from '../base/registry.js';
import type { RedfishTeeHandler } from '../base/tee.js';
import { BaseVendorProfile } from '../base/vendor-profile.js';

const APP_CLASS = 'adapters-redfish';

/** Lenovo XCC3 vendor profile. */
export class LenovoVendorProfile extends BaseVendorProfile {
  readonly tagPattern = /^lenovo\.xcc3\..*/;
  // Discovery detects the controller (xcc3) inside the walk, so at dispatch the
  // tag is still `lenovo..`; match broadly here.
  override readonly discoveryTagPattern = /^lenovo\..*/;

  // `response` is the System document discovery already fetched.
  override async discoverSystemInfo(handler: RedfishDiscoveryHandler, response: JsonRecord): Promise<void> {
    const lenovoModelRaw = 'Model' in response ? response['Model'] : '';
    if (typeof lenovoModelRaw !== 'string') {
      throw new PropertyAccessError(
        `expected string, got '${lenovoModelRaw === null ? 'null' : typeof lenovoModelRaw}'`,
      );
    }
    handler.device.modelFull = lenovoModelRaw;
    const modelMatch = /^(\S+)\s+(\S+)\s+(\S+)$/.exec(handler.device.modelFull);
    if (modelMatch) {
      handler.device.model = modelMatch[2] ?? '';
    }

    const controllerMatch = /^.*(\d+)$/.exec(handler.device.modelFull);
    if (controllerMatch) {
      handler.device.controller = `xcc${controllerMatch[1]}`;
    }

    handler.device.bootState = asString(response['PowerState']);
    handler.device.bootOptions = handler.extractStringArray(
      response,
      'Actions_#ComputerSystem.Reset_ResetType@Redfish.AllowableValues',
    );
    handler.device.rebootEndpoint = handler.extractString(response, 'Actions_#ComputerSystem.Reset_target') ?? '';
    handler.device.managerEndpoint = handler.extractString(response, 'Links_ManagedBy_0_@odata.id') ?? '';
    handler.device.chassisEndpoint = handler.extractString(response, 'Links_Chassis_0_@odata.id') ?? '';

    handler.device.biosGetEndpoint = handler.extractString(response, 'Bios_@odata.id') ?? '';
    if (handler.device.biosGetEndpoint) {
      const biosResponse = await handler.fetch('GET', handler.device.biosGetEndpoint, {});
      handler.device.biosParams = asRecord(biosResponse['Attributes']);

      const lenovoPatchRaw = handler.extractNestedValue(
        biosResponse,
        '@Redfish.Settings_SettingsObject_@odata.id',
        '_',
        `${handler.device.biosGetEndpoint}/Pending`,
      );
      handler.device.biosPatchEndpoint = lenovoPatchRaw ? String(lenovoPatchRaw) : '';

      const biosPendingResponse = await handler.fetch('GET', `${handler.device.biosGetEndpoint}/Pending`, {});
      if (!('Attributes' in biosPendingResponse)) throw new RecordKeyError('Attributes');
      const pendingAttributesRaw = biosPendingResponse['Attributes'];
      if (!isRecord(pendingAttributesRaw)) {
        throw new PropertyAccessError(`'${typeof pendingAttributesRaw}' cannot read property 'entries' of non-object`);
      }
      handler.device.biosPendingParams = diffBiosPendingParams(
        Object.entries(pendingAttributesRaw),
        handler.device.biosParams,
      );
      if (!isEmptyRecord(handler.device.biosPendingParams)) {
        handler.device.rebootNeeded = true;
      }

      if (!('AttributeRegistry' in biosResponse)) throw new RecordKeyError('AttributeRegistry');
      const lenovoRegistryName = String(biosResponse['AttributeRegistry']);
      const biosRegistryResponse = await handler.fetch(
        'GET',
        `/redfish/v1/schemas/registries/${lenovoRegistryName}.json`,
        {},
      );
      handler.device.registry = handler.buildRegistry(
        asArray(handler.extractNestedValue(biosRegistryResponse, 'RegistryEntries_Attributes', '_', [])),
      );
    } else {
      logger.error('failed to determine the bios endpoint', { jobId: handler.jobId, appClassName: APP_CLASS });
    }
  }

  override async reboot(handler: RedfishPowerHandler): Promise<void> {
    const payload = { ResetType: '' };
    for (const restartType of ['GracefulRestart', 'ForceRestart']) {
      if (handler.device.bootOptions.includes(restartType)) {
        payload.ResetType = restartType;
        break;
      }
    }

    if (!payload.ResetType) {
      logger.error(`failed to select a reboot type from the options: ${handler.device.bootOptions.join(', ')}`, {
        jobId: handler.jobId,
        appClassName: APP_CLASS,
      });
      return;
    }

    await handler.fetch('POST', handler.device.rebootEndpoint, payload);
    await sleep(handler.device.rebootTimeout * 1000);

    for (let i = 0; i < handler.device.rebootWaits; i++) {
      const response = await handler.fetch('GET', handler.device.systemEndpoint, {});
      // Each clause is wrapped so its type check only runs when the
      // short-circuit AND would have reached it.
      const powerStateOn = ((): boolean => {
        const raw = 'PowerState' in response ? response['PowerState'] : '';
        if (typeof raw !== 'string') {
          throw new PropertyAccessError(`cannot read property 'toLowerCase' of ${raw === null ? 'null' : typeof raw}`);
        }
        return raw.toLowerCase() === 'on';
      })();
      const healthOk = powerStateOn
        ? ((): boolean => {
            if (!('Status' in response)) {
              return false;
            }
            const statusRaw = response['Status'];
            if (!isRecord(statusRaw)) {
              throw new PropertyAccessError(
                `cannot read property 'get' of ${statusRaw === null ? 'null' : typeof statusRaw}`,
              );
            }
            const healthRaw = 'Health' in statusRaw ? statusRaw['Health'] : '';
            if (typeof healthRaw !== 'string') {
              throw new PropertyAccessError(
                `cannot read property 'toLowerCase' of ${healthRaw === null ? 'null' : typeof healthRaw}`,
              );
            }
            return healthRaw.toLowerCase() === 'ok';
          })()
        : false;
      const lastResetReady =
        powerStateOn && healthOk
          ? ((): boolean => {
              const raw = 'LastResetTime' in response ? response['LastResetTime'] : '';
              if (typeof raw !== 'string') {
                throw new PropertyAccessError(`expected string, got '${typeof raw}'`);
              }
              return !/^[0\-:+TZ]+$/.test(raw);
            })()
          : false;
      if (powerStateOn && healthOk && lastResetReady) {
        logger.info('device has rebooted', { jobId: handler.jobId, appClassName: APP_CLASS });
        handler.device.rebootNeeded = false;
        return;
      }
      await sleep(handler.device.rebootTimeout * 1000);
    }

    logger.info('failed to reboot or to detect the reboot', { jobId: handler.jobId, appClassName: APP_CLASS });
  }

  override async setTee(handler: RedfishTeeHandler, newSetting: boolean): Promise<boolean> {
    const tag = handler.device.tag();
    let settings: Record<string, number | string> = {};

    if (/^lenovo\.xcc3\.sr675$/.test(tag)) {
      if (newSetting) {
        settings = {
          Processors_APICMode: 'x2APIC',
          TrustedComputingGroup_HideTPMfromOS: 'No',
          DevicesandIOPorts_SRIOV: 'Enabled',
          Processors_LimitCPUPAto46bits: 'Disabled',
          Processors_TrustedExecutionTechnology: 'Enabled',
          Processors_MultikeyTotalMemoryEncryption: 'Enabled',
          Processors_TrustDomainExtensionTDX: 'Enabled',
          Processors_TotalMemoryEncryptionTMEBypass: 'Enabled',
          Processors_TDXSecureArbitrationModeLoaderSEAMLoader: 'Enabled',
          Processors_SWGuardExtensions: 'Enabled',
          Processors_SGXPackageInfoIn_BandAccess: 'Enabled',
          Processors_TME_MTTDXkeysplit: 1,
        };
      } else {
        settings = {
          Processors_TME_MTTDXkeysplit: 0,
          Processors_SGXPackageInfoIn_BandAccess: 'Disabled',
          Processors_SWGuardExtensions: 'Disabled',
          Processors_TDXSecureArbitrationModeLoaderSEAMLoader: 'Disabled',
          Processors_TotalMemoryEncryptionTMEBypass: 'Disabled',
          Processors_TrustDomainExtensionTDX: 'Disabled',
          Processors_MultikeyTotalMemoryEncryption: 'Disabled',
          Processors_TrustedExecutionTechnology: 'Disabled',
          Processors_LimitCPUPAto46bits: 'Enabled',
          DevicesandIOPorts_SRIOV: 'Disabled',
          TrustedComputingGroup_HideTPMfromOS: 'Yes',
          Processors_APICMode: 'Auto',
        };
      }
      if (!(await handler.applySequentialBiosSettings(settings))) {
        return false;
      }

      if (newSetting) {
        await handler.setBiosParam('Processors_SGXFactoryReset', 'Enabled');
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

    if (/^lenovo\.xcc3\.sr[67]80a$/.test(tag)) {
      if (newSetting) {
        settings = { Processors_TotalMemoryEncryption: 'Enabled' };
        if (!(await handler.applySequentialBiosSettings(settings))) {
          return false;
        }

        if (handler.device.rebootNeeded) {
          await handler.reboot();
        }

        settings = {
          Processors_LimitCPUPAto46bits: 'Disabled',
          Processors_TotalMemoryEncryptionTMEBypass: 'Auto',
          Processors_MultikeyTotalMemoryEncryption: 'Enabled',
          Processors_Memoryintegrity: 'Disabled',
          Processors_TrustDomainExtensionTDX: 'Enabled',
          Processors_TDXSecureArbitrationModeLoaderSEAMLoader: 'Enabled',
          Processors_DisableexcludingMembelow1MBinCMR: 'Auto',
          Processors_TME_MTTDXkeysplit: 1,
          Processors_SWGuardExtensions: 'Enabled',
        };
        if (!(await handler.applySequentialBiosSettings(settings))) {
          return false;
        }
      } else {
        settings = {
          Processors_SWGuardExtensions: 'Disabled',
          Processors_TDXSecureArbitrationModeLoaderSEAMLoader: 'Disabled',
          Processors_TrustDomainExtensionTDX: 'Disabled',
          Processors_MultikeyTotalMemoryEncryption: 'Disabled',
          Processors_LimitCPUPAto46bits: 'Enabled',
        };
        if (!(await handler.applySequentialBiosSettings(settings))) {
          return false;
        }

        if (handler.device.rebootNeeded) {
          await handler.reboot();
        }

        settings = { Processors_TotalMemoryEncryption: 'Disabled' };
        if (!(await handler.applySequentialBiosSettings(settings))) {
          return false;
        }
      }

      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }

      if (newSetting) {
        await handler.setBiosParam('Processors_SGXFactoryReset', 'Enabled');
        if (handler.device.rebootNeeded) {
          await handler.reboot();
        }
      }

      logger.warning(`TEE is now ${newSetting ? 'enabled' : 'disabled'}`, {
        jobId: handler.jobId,
        appClassName: APP_CLASS,
      });
      return true;
    }

    return super.setTee(handler, newSetting);
  }

  override verifyTee(handler: RedfishTeeHandler) {
    if (!/^lenovo\.xcc3\.(sr675|sr[67]80a)$/.test(handler.device.tag())) {
      return super.verifyTee(handler);
    }
    return Promise.resolve(
      handler.verifyBiosSettings([
        ['', 'Processors_TrustDomainExtensionTDX', ['Enabled']],
        ['', 'Processors_MultikeyTotalMemoryEncryption', ['Enabled']],
        ['', 'Processors_TDXSecureArbitrationModeLoaderSEAMLoader', ['Enabled']],
      ]),
    );
  }

  override async setPxeInterface(handler: RedfishBootHandler): Promise<void> {
    const portChanges: Record<string, string> = {};
    const networkAdapters = await handler.fetch(
      'GET',
      `${handler.device.chassisEndpoint}/NetworkAdapters?$expand=*($levels=2)`,
      {},
    );
    const lenovoAdaptersRaw = 'Members' in networkAdapters ? networkAdapters['Members'] : [];
    if (lenovoAdaptersRaw === null) {
      throw new PropertyAccessError(`null is not iterable`);
    }
    if (!Array.isArray(lenovoAdaptersRaw)) {
      throw new PropertyAccessError(`'${typeof lenovoAdaptersRaw}' is not iterable`);
    }
    for (const adapter of lenovoAdaptersRaw) {
      if (!isRecord(adapter)) {
        throw new PropertyAccessError(`cannot read property 'get' of ${typeof adapter}`);
      }
      const controllersRaw = 'Controllers' in adapter ? adapter['Controllers'] : [];
      if (controllersRaw === null) {
        throw new PropertyAccessError(`null is not iterable`);
      }
      if (!Array.isArray(controllersRaw)) {
        throw new PropertyAccessError(`'${typeof controllersRaw}' is not iterable`);
      }
      for (const controller of controllersRaw) {
        if (!isRecord(controller)) {
          throw new PropertyAccessError(`cannot read property 'get' of ${typeof controller}`);
        }
        const controllerRecord = controller;
        // Distinguish missing keys (default to {}) from explicit-null (raise)
        // so malformed Location/PartLocation surfaces instead of silent skip.
        const locationRaw = 'Location' in controllerRecord ? controllerRecord['Location'] : {};
        if (!isRecord(locationRaw)) {
          throw new PropertyAccessError(`cannot read property 'get' of null`);
        }
        const partLocationRaw = 'PartLocation' in locationRaw ? locationRaw['PartLocation'] : {};
        if (!isRecord(partLocationRaw)) {
          throw new PropertyAccessError(`cannot read property 'get' of null`);
        }
        const slotNumber = String(
          'LocationOrdinalValue' in partLocationRaw ? partLocationRaw['LocationOrdinalValue'] : '',
        );

        const linksRaw = 'Links' in controllerRecord ? controllerRecord['Links'] : {};
        if (!isRecord(linksRaw)) {
          throw new PropertyAccessError(`cannot read property 'get' of null`);
        }
        const portsRaw = 'Ports' in linksRaw ? linksRaw['Ports'] : [];
        if (portsRaw === null) {
          throw new PropertyAccessError(`null is not iterable`);
        }
        if (!Array.isArray(portsRaw)) {
          throw new PropertyAccessError(`'${typeof portsRaw}' is not iterable`);
        }
        for (const port of portsRaw) {
          if (!isRecord(port)) {
            throw new PropertyAccessError(`cannot read property 'get' of ${typeof port}`);
          }
          const portRecord = port;
          const linkStatusRawValue = 'LinkStatus' in portRecord ? portRecord['LinkStatus'] : '';
          if (typeof linkStatusRawValue !== 'string') {
            throw new PropertyAccessError(
              `cannot read property 'toLowerCase' of ${linkStatusRawValue === null ? 'null' : typeof linkStatusRawValue}`,
            );
          }
          const linkStatus = linkStatusRawValue.toLowerCase();
          const targetBootProtocol = ['linkup', 'up'].includes(linkStatus) ? 'PXE' : 'None';
          const portId = String('Id' in portRecord ? portRecord['Id'] : '');

          const keyPattern = new RegExp(
            `${escapeRegExp(slotNumber)}PhysicalPort${escapeRegExp(portId)}LogicalPort\\d+_LegacyBootProtocol$`,
          );
          const matchingKeys = Object.keys(handler.device.biosParams).filter((biosKey) => keyPattern.test(biosKey));

          for (const attrKey of matchingKeys) {
            if (handler.device.biosParams[attrKey] === targetBootProtocol) {
              logger.info(`port ${slotNumber}.${portId} already has the correct boot protocol: ${targetBootProtocol}`, {
                jobId: handler.jobId,
                appClassName: APP_CLASS,
              });
              continue;
            }

            portChanges[attrKey] = targetBootProtocol;

            const linkStatusForLog = String('LinkStatus' in portRecord ? portRecord['LinkStatus'] : 'Unknown');
            logger.info(
              `set ${attrKey} to ${targetBootProtocol} based on port ` + `${portId} link status (${linkStatusForLog})`,
              { jobId: handler.jobId, appClassName: APP_CLASS },
            );
          }
        }
      }
    }

    if (isEmptyRecord(portChanges)) {
      logger.warning('no Lenovo port-specific LegacyBootProtocol attributes were updated', {
        jobId: handler.jobId,
        appClassName: APP_CLASS,
      });
      return;
    }

    await handler.fetch('PATCH', handler.device.biosPatchEndpoint, { Attributes: portChanges }, undefined, 90);
  }

  override async setBootPxe(handler: RedfishBootHandler): Promise<void> {
    const systemResponse = await handler.fetch('GET', handler.device.systemEndpoint, {});
    const allowableValuesRaw =
      (systemResponse['Boot'] as Record<string, unknown> | undefined)?.[
        'BootSourceOverrideEnabled@Redfish.AllowableValues'
      ] ?? [];
    if (allowableValuesRaw === null || allowableValuesRaw === undefined) {
      throw new RecordTypeError(`argument of type 'null' is not iterable`);
    }
    const containsContinuous = Array.isArray(allowableValuesRaw) ? allowableValuesRaw.includes('Continuous') : false;

    await handler.fetch('PATCH', handler.device.systemEndpoint, {
      Boot: {
        BootSourceOverrideTarget: 'Pxe',
        BootSourceOverrideMode: 'UEFI',
        BootSourceOverrideEnabled: containsContinuous ? 'Continuous' : 'Once',
      },
    });

    await handler.setBiosParam('NetworkStackSettings_IPv4PXESupport', 'Enabled');
    await handler.setBiosParam('NetworkStackSettings_IPv6PXESupport', 'Disabled');
  }

  override async setIpmi(handler: RedfishBootHandler, newSetting: boolean): Promise<void> {
    if (!handler.device.managerEndpoint) {
      logger.error("can't apply new parameters, failed to determine the Manager endpoint", {
        jobId: handler.jobId,
        appClassName: APP_CLASS,
      });
      return;
    }

    if (!handler.device.networkEndpoint) {
      const managerResponse = await handler.fetch('GET', handler.device.managerEndpoint, {});
      const lenovoExtract = handler.extractString(managerResponse, 'NetworkProtocol_@odata.id');
      handler.device.networkEndpoint = lenovoExtract ?? '';
    }

    let response = await handler.fetch('GET', handler.device.networkEndpoint, {});

    const protocolEnabled = handler.extractNestedValue(response, 'IPMI_ProtocolEnabled');
    if (protocolEnabled === null) {
      logger.error('failed to determine the current IPMI setting', { jobId: handler.jobId, appClassName: APP_CLASS });
      return;
    }

    if (redfishBoolMatches(protocolEnabled, newSetting)) {
      logger.warning(`IPMI is already ${newSetting ? 'enabled' : 'disabled'}`, {
        jobId: handler.jobId,
        appClassName: APP_CLASS,
      });
      return;
    }

    response = await handler.fetch('PATCH', handler.device.networkEndpoint, { IPMI: { ProtocolEnabled: newSetting } });

    const patchMessage = handler.extractString(response, '@Message.ExtendedInfo_0_Message');
    if (patchMessage === null) {
      return;
    }
    const message = patchMessage.toLowerCase();

    if (message.includes('successfully completed') || message.includes('completed successfully')) {
      logger.warning(`IPMI is now ${newSetting ? 'enabled' : 'disabled'}`, {
        jobId: handler.jobId,
        appClassName: APP_CLASS,
      });

      if (message.includes('reset')) {
        handler.device.rebootNeeded = true;
        logger.warning('IPMI setting change requires a reboot to take effect', {
          jobId: handler.jobId,
          appClassName: APP_CLASS,
        });
      }
    }

    if (!newSetting) {
      return;
    }

    const accountServiceResponse = await handler.fetch('GET', handler.device.accountserviceEndpoint, {});
    const accountsEndpoint = handler.extractString(accountServiceResponse, 'Accounts_@odata.id');
    if (accountsEndpoint === null) {
      logger.error('failed to determine the Accounts endpoint', { jobId: handler.jobId, appClassName: APP_CLASS });
      return;
    }

    const accounts = await handler.fetch('GET', accountsEndpoint, {});
    if (isEmptyRecord(accounts)) {
      logger.error('failed to find the Accounts', { jobId: handler.jobId, appClassName: APP_CLASS });
      return;
    }

    let currentAccountEndpoint = '';
    let currentAccountResponse: JsonRecord = {};
    const lenovoMembersRaw = 'Members' in accounts ? accounts['Members'] : [];
    if (lenovoMembersRaw === null) {
      throw new PropertyAccessError(`null is not iterable`);
    }
    if (!Array.isArray(lenovoMembersRaw)) {
      throw new PropertyAccessError(`'${typeof lenovoMembersRaw}' is not iterable`);
    }
    for (const account of lenovoMembersRaw) {
      if (!isRecord(account)) {
        throw new PropertyAccessError(`cannot read property 'get' of ${typeof account}`);
      }
      // Non-string @odata.id values pass through to fetch as-is; only
      // None/missing skips this account.
      const rawAccountEndpoint = account['@odata.id'];
      if (rawAccountEndpoint === undefined || rawAccountEndpoint === null) {
        logger.error('failed to determine the Account endpoint', { jobId: handler.jobId, appClassName: APP_CLASS });
        continue;
      }
      const accountEndpoint = String(rawAccountEndpoint);

      const accountResponse = await handler.fetch('GET', accountEndpoint, {});
      const usernameRaw = 'UserName' in accountResponse ? accountResponse['UserName'] : '';
      if (typeof usernameRaw !== 'string') {
        throw new PropertyAccessError(`cannot read property 'toLowerCase' of ${typeof usernameRaw}`);
      }
      if (usernameRaw.toLowerCase() === handler.device.username.toLowerCase()) {
        currentAccountEndpoint = accountEndpoint;
        currentAccountResponse = accountResponse;
        break;
      }
    }

    if (!currentAccountEndpoint) {
      logger.error('failed to find the Account', { jobId: handler.jobId, appClassName: APP_CLASS });
      return;
    }

    const accountTypesRaw = 'AccountTypes' in currentAccountResponse ? currentAccountResponse['AccountTypes'] : [];
    const accountTypesHasIpmi = Array.isArray(accountTypesRaw)
      ? accountTypesRaw.includes('IPMI')
      : isRecord(accountTypesRaw)
        ? 'IPMI' in accountTypesRaw
        : false;
    if (accountTypesHasIpmi) {
      logger.warning(`account ${asString(currentAccountResponse['UserName'])} is already an IPMI account`, {
        jobId: handler.jobId,
        appClassName: APP_CLASS,
      });
      return;
    }

    if (!Array.isArray(accountTypesRaw)) {
      throw new RecordTypeError(
        `cannot concatenate '${accountTypesRaw === null ? 'null' : typeof accountTypesRaw}' with array`,
      );
    }
    response = await handler.fetch('PATCH', currentAccountEndpoint, {
      AccountTypes: [...accountTypesRaw, 'IPMI'],
    });
    const accountTypeMessage = handler.extractString(response, '@Message.ExtendedInfo_0_Message');
    if (accountTypeMessage === null) {
      return;
    }
    const accountTypeMessageLower = accountTypeMessage.toLowerCase();

    if (
      accountTypeMessageLower.includes('successfully completed') ||
      accountTypeMessageLower.includes('completed successfully')
    ) {
      logger.info(`account ${asString(currentAccountResponse['UserName'])} is now an IPMI account`, {
        jobId: handler.jobId,
        appClassName: APP_CLASS,
      });
    }

    logger.info(`resetting the password for account ${asString(currentAccountResponse['UserName'])}`, {
      jobId: handler.jobId,
      appClassName: APP_CLASS,
    });
    response = await handler.fetch('PATCH', currentAccountEndpoint, {
      Password: handler.device.password,
      PasswordChangeRequired: false,
    });
    const passwordMessage = handler.extractString(response, '@Message.ExtendedInfo_0_Message');
    if (passwordMessage === null) {
      return;
    }
    const passwordMessageLower = passwordMessage.toLowerCase();

    if (
      passwordMessageLower.includes('successfully completed') ||
      passwordMessageLower.includes('completed successfully')
    ) {
      logger.warning(
        `password for account ${asString(currentAccountResponse['UserName'])} has been reset to its same value`,
        {
          jobId: handler.jobId,
          appClassName: APP_CLASS,
        },
      );
    }
  }

  override async setSecureboot(handler: RedfishBootHandler, newSetting: boolean): Promise<void> {
    const securebootResponse = await handler.fetch('GET', handler.device.securebootEndpoint, {});
    if (redfishBoolMatches(securebootResponse['SecureBootEnabled'], newSetting)) {
      logger.info(`Secure Boot is already ${newSetting ? 'enabled' : 'disabled'}`, {
        jobId: handler.jobId,
        appClassName: APP_CLASS,
      });
      return;
    }

    const response = await handler.fetch('PATCH', handler.device.securebootEndpoint, { SecureBootEnabled: newSetting });
    const message = handler.extractString(response, '@Message.ExtendedInfo_0_Message');
    if (message === null) {
      return;
    }

    if (message.includes('successfully completed') || message.includes('completed successfully')) {
      logger.warning(`secure boot is now ${newSetting ? 'enabled' : 'disabled'}`, {
        jobId: handler.jobId,
        appClassName: APP_CLASS,
      });

      if (message.includes('reset')) {
        handler.device.rebootNeeded = true;
        logger.info('secure boot setting change requires a reboot to take effect', {
          jobId: handler.jobId,
          appClassName: APP_CLASS,
        });
        await handler.reboot();
      }
    }
  }
}

registerVendorProfile(new LenovoVendorProfile());
