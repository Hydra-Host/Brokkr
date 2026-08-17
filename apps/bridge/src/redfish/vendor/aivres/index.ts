import { isRecord } from '@repo/utils';

import {
  asRecord,
  asString,
  isEmptyRecord,
  type JsonRecord,
  logger,
  PropertyAccessError,
  redfishBoolMatches,
} from '../base/base.js';
import type { RedfishBootHandler } from '../base/boot.js';
import type { RedfishDiscoveryHandler } from '../base/discovery.js';
import type { RedfishPowerHandler } from '../base/power.js';
import { pollResetRebootWithPendingBios } from '../base/reboot-helpers.js';
import { registerVendorProfile } from '../base/registry.js';
import type { RedfishTeeHandler } from '../base/tee.js';
import { BaseVendorProfile } from '../base/vendor-profile.js';

const APP_CLASS = 'adapters-redfish';

/** Aivres (AST2600 / OpenBMC) vendor profile. */
export class AivresVendorProfile extends BaseVendorProfile {
  readonly tagPattern = /^aivres\..*/;
  // BIOS PATCH on Aivres requires an If-Match ETag round-trip.
  override readonly requiresEtag = true;

  // Discovery detection pre-populates the full aivres tag, so model dispatch works here at discovery time.
  override async discoverSystemInfo(handler: RedfishDiscoveryHandler, response: JsonRecord): Promise<void> {
    const tag = handler.device.tag();

    if (/^aivres\.ast2600\..*/.test(tag)) {
      const aivresAst2600ModelRaw = 'Model' in response ? response['Model'] : '';
      if (typeof aivresAst2600ModelRaw !== 'string') {
        throw new PropertyAccessError(
          `'${aivresAst2600ModelRaw === null ? 'null' : typeof aivresAst2600ModelRaw}' cannot read property 'trim' of non-string`,
        );
      }
      handler.device.modelFull = aivresAst2600ModelRaw.trim();
      handler.device.model = handler.device.modelFull.toLowerCase();

      handler.device.bootState = asString(response['PowerState']);
      const resetActionEndpoint = handler.extractString(response, 'Actions_#ComputerSystem.Reset_target');
      handler.device.bootOptions = handler.extractStringArray(
        response,
        'Actions_#ComputerSystem.Reset_ResetType@Redfish.AllowableValues',
      );
      if (!resetActionEndpoint) {
        logger.warning('failed to determine the reboot options endpoint', {
          jobId: handler.jobId,
          appClassName: APP_CLASS,
        });
      }

      handler.device.chassisEndpoint = handler.extractString(response, 'Links_Chassis_0_@odata.id') ?? '';

      await handler.fallbackModelFromManagerOem();

      handler.device.biosGetEndpoint = handler.extractString(response, 'Bios_@odata.id') ?? '';
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
      } else {
        logger.error('failed to determine the bios endpoint', { jobId: handler.jobId, appClassName: APP_CLASS });
      }

      handler.device.rebootEndpoint = handler.extractString(response, 'Actions_#ComputerSystem.Reset_target') ?? '';
      if (!handler.device.rebootEndpoint) {
        logger.error('failed to determine the reboot endpoint', { jobId: handler.jobId, appClassName: APP_CLASS });
      }

      return;
    }

    if (/^aivres\.openbmc\..*/.test(tag)) {
      const aivresOpenbmcModelRaw = 'Model' in response ? response['Model'] : '';
      if (typeof aivresOpenbmcModelRaw !== 'string') {
        throw new PropertyAccessError(
          `'${aivresOpenbmcModelRaw === null ? 'null' : typeof aivresOpenbmcModelRaw}' cannot read property 'trim' of non-string`,
        );
      }
      handler.device.modelFull = aivresOpenbmcModelRaw.trim();
      handler.device.model = handler.device.modelFull.toLowerCase();

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

      handler.device.chassisEndpoint = handler.extractString(response, 'Links_Chassis_0_@odata.id') ?? '';

      await handler.fallbackModelFromManagerOem();

      handler.device.biosGetEndpoint = handler.extractString(response, 'Bios_@odata.id') ?? '';
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
      } else {
        logger.error('failed to determine the bios endpoint', { jobId: handler.jobId, appClassName: APP_CLASS });
      }

      handler.device.rebootEndpoint = handler.extractString(response, 'Actions_#ComputerSystem.Reset_target') ?? '';
      if (!handler.device.rebootEndpoint) {
        logger.error('failed to determine the reboot endpoint', { jobId: handler.jobId, appClassName: APP_CLASS });
      }

      return;
    }

    return super.discoverSystemInfo(handler, response);
  }

  override reboot(handler: RedfishPowerHandler): Promise<void> {
    return pollResetRebootWithPendingBios(handler);
  }

  // Model dispatch stays inside the brand; an aivres tag matching neither model
  // falls through to the base default.
  override async setTee(handler: RedfishTeeHandler, newSetting: boolean): Promise<boolean> {
    const tag = handler.device.tag();

    if (/^aivres\.ast2600\..*/.test(tag)) {
      if (newSetting) {
        await handler.setBiosParam('ProcessorVmxEnable', 'Enabled', 'SocketProcessorCoreConfig');

        if (
          (handler.device.biosParams['IntelSetup'] as Record<string, unknown> | undefined)?.['DfxAdvDebugJumper'] !==
          'Disabled'
        ) {
          await handler.setBiosParam('DfxAdvDebugJumper', 'Disabled', 'IntelSetup');
          await handler.reboot();
        }

        await handler.setBiosParam('VTdSupport', 'Enabled', 'SocketIioConfig');
        await handler.setBiosParam('CpuPaLimit', 'Disabled', 'SocketMpLinkConfig');

        if (
          (handler.device.biosParams['SocketSecurityConfig'] as Record<string, unknown> | undefined)?.['EnableTme'] !==
          'Enabled'
        ) {
          await handler.setBiosParam('EnableTme', 'Enabled', 'SocketSecurityConfig');
          await handler.reboot();
        }

        if (
          (handler.device.biosParams['SocketSecurityConfig'] as Record<string, unknown> | undefined)?.[
            'EnableMktme'
          ] !== 'Enabled'
        ) {
          await handler.setBiosParam('EnableMktme', 'Enabled', 'SocketSecurityConfig');
          await handler.reboot();
        }

        await handler.setBiosParam('EnableTmeBypass', 'Enabled', 'SocketSecurityConfig');
        await handler.setBiosParam('EnableTdx', 'Enabled', 'SocketSecurityConfig');

        if (
          (handler.device.biosParams['SocketSecurityConfig'] as Record<string, unknown> | undefined)?.['EnableSgx'] !==
          'Enabled'
        ) {
          await handler.setBiosParam('EnableSgx', 'Enabled', 'SocketSecurityConfig');
          await handler.reboot();
        }

        await handler.setBiosParam('SgxPackageInfoInBandAccess', 'Enabled', 'SocketSecurityConfig');

        if (handler.device.rebootNeeded) {
          await handler.reboot();
        }

        await handler.setBiosParam('EnableGlobalIntegrity', 'Disabled', 'SocketSecurityConfig');

        if (handler.device.rebootNeeded) {
          await handler.reboot();
        }

        await handler.setBiosParam('SgxFactoryReset', 'Enabled', 'SocketSecurityConfig');
      } else {
        await handler.setBiosParam('EnableGlobalIntegrity', 'Enabled', 'SocketSecurityConfig');
        await handler.setBiosParam('EnableTmeBypass', 'Disabled', 'SocketSecurityConfig');
        await handler.setBiosParam('VTdSupport', 'Disabled', 'SocketIioConfig');
        await handler.setBiosParam('CpuPaLimit', 'Enabled', 'SocketMpLinkConfig');
        await handler.setBiosParam('EnableTme', 'Disabled', 'SocketSecurityConfig');
        await handler.setBiosParam('EnableTdx', 'Disabled', 'SocketSecurityConfig');
        await handler.setBiosParam('EnableSgx', 'Disabled', 'SocketSecurityConfig');
        await handler.setBiosParam('VMX', 'Disabled', 'SocketProcessorCoreConfig');
        await handler.setBiosParam('DfxAdvDebugJumper', 'Auto', 'IntelSetup');
      }

      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }

      logger.info(`TEE is now ${newSetting ? 'enabled' : 'disabled'}`, {
        jobId: handler.jobId,
        appClassName: APP_CLASS,
      });
      return true;
    }

    if (/^aivres\.openbmc\..*/.test(tag)) {
      if (newSetting) {
        await handler.setBiosParam('VMX', 'Enabled', 'SocketProcessorCoreConfig');
        await handler.setBiosParam('VTdSupport', 'Enabled', 'SocketIioConfig');
        await handler.setBiosParam('Limit CPU PA to 46 bits', 'Disabled', 'SocketMpLinkConfig');
        await handler.setBiosParam('Memory Encryption (TME)', 'Enabled', 'SocketSecurityConfig');
        await handler.setBiosParam('Trust Domain Extension (TDX)', 'Enabled', 'SocketSecurityConfig');
        await handler.setBiosParam('SW Guard Extensions (SGX)', 'Enabled', 'SocketSecurityConfig');

        await handler.setBiosParam('Total Memory Encryption Multi-Tenant(TME-MT)', 'Enabled', 'SocketSecurityConfig');

        await handler.setBiosParam('PRMRR/SEAMRR support', 'Enabled', 'SocketSecurityConfig');

        await handler.setBiosParam('Advanced Debug Function', 'Disabled', 'IntelSetup');

        if (handler.device.rebootNeeded) {
          await handler.reboot();
        }

        await handler.setBiosParam('SGX Package Info In-Band Access', 'Enabled', 'SocketSecurityConfig');

        if (handler.device.rebootNeeded) {
          await handler.reboot();
        }

        await handler.setBiosParam('SGX Factory Reset', 'Enabled', 'SocketSecurityConfig');
      } else {
        await handler.setBiosParam('Advanced Debug Function', 'Auto', 'IntelSetup');
        await handler.setBiosParam('PRMRR/SEAMRR support', 'Auto', 'SocketSecurityConfig');
        await handler.setBiosParam('Total Memory Encryption Multi-Tenant(TME-MT)', 'Disabled', 'SocketSecurityConfig');
        await handler.setBiosParam('SW Guard Extensions (SGX)', 'Disabled', 'SocketSecurityConfig');
        await handler.setBiosParam('Trust Domain Extension (TDX)', 'Disabled', 'SocketSecurityConfig');
        await handler.setBiosParam('Memory Encryption (TME)', 'Disabled', 'SocketSecurityConfig');
        await handler.setBiosParam('Limit CPU PA to 46 bits', 'Enabled', 'SocketMpLinkConfig');
      }

      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }

      logger.info(`TEE is now ${newSetting ? 'enabled' : 'disabled'}`, {
        jobId: handler.jobId,
        appClassName: APP_CLASS,
      });
      return true;
    }

    return super.setTee(handler, newSetting);
  }

  override verifyTee(handler: RedfishTeeHandler) {
    const tag = handler.device.tag();
    if (/^aivres\.ast2600\..*/.test(tag)) {
      return Promise.resolve(
        handler.verifyBiosSettings([
          ['SocketSecurityConfig', 'EnableTme', ['Enabled']],
          ['SocketSecurityConfig', 'EnableMktme', ['Enabled']],
          ['SocketSecurityConfig', 'EnableTdx', ['Enabled']],
          ['SocketSecurityConfig', 'EnableSgx', ['Enabled']],
        ]),
      );
    }
    if (/^aivres\.openbmc\..*/.test(tag)) {
      return Promise.resolve(
        handler.verifyBiosSettings([
          ['SocketSecurityConfig', 'Memory Encryption (TME)', ['Enabled']],
          ['SocketSecurityConfig', 'Total Memory Encryption Multi-Tenant(TME-MT)', ['Enabled']],
          ['SocketSecurityConfig', 'Trust Domain Extension (TDX)', ['Enabled']],
          ['SocketSecurityConfig', 'SW Guard Extensions (SGX)', ['Enabled']],
        ]),
      );
    }
    return super.verifyTee(handler);
  }

  override async preBootTweaks(handler: RedfishBootHandler): Promise<void> {
    await handler.setBiosParam('Fixed Boot Order Control', 'Disabled', 'Setup');
    if (handler.device.rebootNeeded) {
      await handler.reboot();
    }
  }

  override async findActiveInterfaces(handler: RedfishBootHandler): Promise<JsonRecord[]> {
    const activeInterfaces: JsonRecord[] = [];
    const networkAdapters = await handler.fetch('GET', '/redfish/v1/Chassis/1/NetworkAdapters', {});
    // Distinguish missing Members (defaults to []) from explicit-null
    // (raises) so a malformed response surfaces instead of silently no-op-ing.
    const aivresMembersRaw = 'Members' in networkAdapters ? networkAdapters['Members'] : [];
    if (aivresMembersRaw === null) {
      throw new PropertyAccessError(`null is not iterable`);
    }
    if (!Array.isArray(aivresMembersRaw)) {
      throw new PropertyAccessError(`'${typeof aivresMembersRaw}' is not iterable`);
    }
    for (const adapter of aivresMembersRaw) {
      const adapterEndpoint = String((adapter as Record<string, unknown>)?.['@odata.id']);
      const adapterResponse = await handler.fetch('GET', adapterEndpoint, {});
      const networkPortUrl = handler.extractString(adapterResponse, 'NetworkPorts_@odata.id');
      if (networkPortUrl === null) {
        continue;
      }
      const networkPortResponse = await handler.fetch('GET', networkPortUrl, {});
      if (asString(networkPortResponse['LinkStatus']) === 'Up') {
        activeInterfaces.push(adapterResponse);
      }
    }

    return activeInterfaces;
  }

  override async setBootPxe(handler: RedfishBootHandler): Promise<void> {
    const tag = handler.device.tag();

    if (/^aivres\.ast2600.*/.test(tag)) {
      await handler.setBiosParam('Ipv4Pxe', 'Enabled', 'NetworkStackVar');
      await handler.setBiosParam('Ipv6Pxe', 'Disabled', 'NetworkStackVar');
      await handler.setBiosParam('UefiPriorities', ['Network', 'Hdd', 'Odd', 'Other'], 'FixedBootPriorities');
      await handler.fetch('PATCH', handler.device.systemEndpoint, {
        Boot: {
          BootSourceOverrideTarget: 'Pxe',
          BootSourceOverrideEnabled: 'Continuous',
          BootSourceOverrideMode: 'UEFI',
        },
      });
      return;
    }

    if (/^aivres\.openbmc\..*/.test(tag)) {
      await handler.setBiosParam('IPv4 PXE Support', 'Enabled', 'NetworkStackVar');
      await handler.setBiosParam('IPv4 HTTP Support', 'Disabled', 'NetworkStackVar');
      await handler.setBiosParam('IPv6 PXE Support', 'Disabled', 'NetworkStackVar');
      await handler.setBiosParam('IPv6 HTTPS Support', 'Disabled', 'NetworkStackVar');
      return;
    }

    return super.setBootPxe(handler);
  }

  override async setIpmi(handler: RedfishBootHandler, newSetting: boolean): Promise<void> {
    let response = await handler.fetch('GET', handler.device.managerEndpoint, {});
    const aivresExtract = handler.extractString(response, 'NetworkProtocol_@odata.id');
    handler.device.networkEndpoint = aivresExtract ?? '';

    response = await handler.fetch('GET', handler.device.networkEndpoint, {});
    const ipmiRaw = 'IPMI' in response ? response['IPMI'] : {};
    if (!isRecord(ipmiRaw)) {
      throw new PropertyAccessError(`cannot read property 'get' of null`);
    }
    const protocolEnabled = ipmiRaw['ProtocolEnabled'];

    if (protocolEnabled === undefined || protocolEnabled === null) {
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

    await handler.fetch('PATCH', handler.device.networkEndpoint, { IPMI: { ProtocolEnabled: newSetting } });
  }
}

registerVendorProfile(new AivresVendorProfile());
