import { isRecord } from '@repo/utils';

import {
  asArray,
  asRecord,
  asString,
  isEmptyRecord,
  type JsonRecord,
  logger,
  PropertyAccessError,
  RecordIndexError,
  RecordKeyError,
  RecordTypeError,
  redfishBoolMatches,
  UninitializedVariableError,
} from '../base/base.js';
import { filterLinkUpEthernetInterfaces, patchStandardPxeBootOverride } from '../base/boot-helpers.js';
import type { RedfishBootHandler } from '../base/boot.js';
import type { RedfishDiscoveryHandler } from '../base/discovery.js';
import type { RedfishPowerHandler } from '../base/power.js';
import { registerVendorProfile } from '../base/registry.js';
import type { RedfishTeeHandler } from '../base/tee.js';
import { BaseVendorProfile } from '../base/vendor-profile.js';
import { RedfishDellHandler } from './dell.js';

const APP_CLASS = 'adapters-redfish';

/** Dell iDRAC9 vendor profile. */
export class DellVendorProfile extends BaseVendorProfile {
  readonly tagPattern = /^dell\.idrac9\..*/;
  // Discovery detects the controller (idrac9) inside the walk, so at dispatch the
  // tag is still `dell..`; match broadly here.
  override readonly discoveryTagPattern = /^dell\..*/;

  // Pass through the requester so an injected mock drives the Dell sub-lifecycle.
  override reboot(handler: RedfishPowerHandler): Promise<void> {
    return new RedfishDellHandler(handler.device, handler.jobId, handler.requester).runBiosConfigLifecycle();
  }

  // `response` is the System document discovery already fetched.
  override async discoverSystemInfo(handler: RedfishDiscoveryHandler, response: JsonRecord): Promise<void> {
    const dellModelRaw = 'Model' in response ? response['Model'] : '';
    if (typeof dellModelRaw !== 'string') {
      throw new PropertyAccessError(`expected string, got '${typeof dellModelRaw}'`);
    }
    handler.device.modelFull = dellModelRaw;
    const modelMatch = /^(\S+)\s+(\S+)$/.exec(handler.device.modelFull);
    if (modelMatch) {
      handler.device.model = modelMatch[2] ?? '';
    }

    const bootStateRaw = (response['BootProgress'] as Record<string, unknown> | undefined)?.['LastState'] ?? '';
    handler.device.bootState = asString(bootStateRaw);
    handler.device.bootOptions = handler.extractStringArray(
      response,
      'Actions_#ComputerSystem.Reset_ResetType@Redfish.AllowableValues',
    );
    handler.device.rebootEndpoint = handler.extractString(response, 'Actions_#ComputerSystem.Reset_target') ?? '';

    handler.device.managerEndpoint = handler.extractString(response, 'Links_ManagedBy_0_@odata.id') ?? '';
    if (!handler.device.managerEndpoint) {
      logger.error('failed to determine the Manager endpoint', { jobId: handler.jobId, appClassName: APP_CLASS });
      return;
    }

    const managerResponse = await handler.fetch('GET', handler.device.managerEndpoint, {});
    const dellManagerModelRaw = 'Model' in managerResponse ? managerResponse['Model'] : '';
    if (typeof dellManagerModelRaw !== 'string') {
      throw new PropertyAccessError(`expected string, got '${typeof dellManagerModelRaw}'`);
    }
    if (/^1[4-6].*/.test(dellManagerModelRaw)) {
      handler.device.controller = 'idrac9';
      handler.device.dellLcServiceEndpoint =
        '/redfish/v1/Dell/Managers/iDRAC.Embedded.1/DellLCService/Actions/DellLCService.GetRemoteServicesAPIStatus';
    }

    handler.device.jobsByState = {};

    handler.device.jobserviceEndpoint = handler.extractString(managerResponse, 'Links_Oem_Dell_Jobs_@odata.id') ?? '';
    if (handler.device.jobserviceEndpoint) {
      const jobsList = await handler.fetch('GET', `${handler.device.jobserviceEndpoint}?$expand=*($levels=1)`, {});
      const dellJobMembersRaw = 'Members' in jobsList ? jobsList['Members'] : [];
      if (dellJobMembersRaw === null) {
        throw new PropertyAccessError(`'null' object is not iterable`);
      }
      if (!Array.isArray(dellJobMembersRaw)) {
        throw new PropertyAccessError(`'${typeof dellJobMembersRaw}' object is not iterable`);
      }
      for (const job of dellJobMembersRaw) {
        if (!isRecord(job)) {
          throw new PropertyAccessError(`argument of type '${job === null ? 'null' : typeof job}' is not iterable`);
        }
        if (!('JobState' in job)) continue;
        const state = String(job['JobState']);
        handler.device.jobsByState[state] = [...(handler.device.jobsByState[state] ?? []), job];
      }

      const pendingJobs = handler.device.jobsByState['Pending'];
      if (pendingJobs !== undefined) {
        logger.warning(`there are ${pendingJobs.length} pending jobs that require a reboot to take effect`, {
          jobId: handler.jobId,
          appClassName: APP_CLASS,
        });
      }
      const runningJobs = handler.device.jobsByState['Running'];
      if (runningJobs !== undefined) {
        const runningNames = runningJobs.map((job) => {
          if (!('Name' in job)) throw new RecordKeyError('Name');
          return job['Name'];
        });
        for (const name of runningNames) {
          if (typeof name !== 'string') {
            throw new RecordTypeError(`array element: expected string, got ${name === null ? 'null' : typeof name}`);
          }
        }
        logger.warning(`there are active jobs on the system: ${(runningNames as string[]).join(', ')}`, {
          jobId: handler.jobId,
          appClassName: APP_CLASS,
        });
      }
    } else {
      logger.error('failed to determine the JobService endpoint', { jobId: handler.jobId, appClassName: APP_CLASS });
    }

    // biosResponse is unbound on the else-branch; surface that as an
    // UninitializedVariableError below instead of silently extracting from undefined.
    let biosResponse: JsonRecord | undefined;
    handler.device.biosGetEndpoint = handler.extractString(response, 'Bios_@odata.id') ?? '';
    if (handler.device.biosGetEndpoint) {
      biosResponse = await handler.fetch('GET', handler.device.biosGetEndpoint, {});
      handler.device.biosParams = asRecord(biosResponse['Attributes']);
    } else {
      logger.error('failed to determine the bios endpoint', { jobId: handler.jobId, appClassName: APP_CLASS });
    }

    if (biosResponse === undefined) {
      // Python-parity message.
      throw new UninitializedVariableError("local variable 'bios_response' referenced before assignment");
    }
    handler.device.biosPatchEndpoint =
      handler.extractString(biosResponse, '@Redfish.Settings_SettingsObject_@odata.id') ?? '';
    if (handler.device.biosPatchEndpoint) {
      biosResponse = await handler.fetch('GET', handler.device.biosPatchEndpoint, {});
      handler.device.biosPendingParams = asRecord(biosResponse['Attributes']);
      if (!isEmptyRecord(handler.device.biosPendingParams)) {
        handler.device.rebootNeeded = true;
      }
    }

    if (handler.device.registriesEndpoint) {
      const registriesResponse = await handler.fetch('GET', handler.device.registriesEndpoint, {});
      if (!('Members' in registriesResponse)) throw new RecordKeyError('Members');
      const dellMembers = registriesResponse['Members'];
      if (!Array.isArray(dellMembers)) {
        throw new RecordTypeError(`'${dellMembers === null ? 'null' : typeof dellMembers}' object is not iterable`);
      }
      const attributesEndpoints: string[] = [];
      for (const item of dellMembers) {
        if (!isRecord(item) || !('@odata.id' in item)) throw new RecordKeyError('@odata.id');
        const odataId = item['@odata.id'];
        if (typeof odataId !== 'string') {
          throw new PropertyAccessError(`argument of type '${typeof odataId}' is not iterable`);
        }
        if (odataId.includes('BiosAttributeRegistry')) {
          attributesEndpoints.push(odataId);
        }
      }
      const attributesEndpoint = attributesEndpoints[0];
      if (attributesEndpoint !== undefined) {
        const attributesResponse = await handler.fetch('GET', attributesEndpoint, {});
        // Only explicit-null Location skips; missing → [] still enters the
        // block and throws RecordIndexError on [0]["Uri"].
        const locRaw = 'Location' in attributesResponse ? attributesResponse['Location'] : [];
        if (locRaw !== null) {
          if (!Array.isArray(locRaw)) {
            throw new RecordTypeError(`'${typeof locRaw}' object is not indexable`);
          }
          if (locRaw.length === 0) throw new RecordIndexError();
          const firstLoc = asRecord(locRaw[0]);
          if (!('Uri' in firstLoc)) throw new RecordKeyError('Uri');
          const uri = String(firstLoc['Uri']);
          const biosRegistryResponse = await handler.fetch('GET', uri, {});
          handler.device.registry = handler.buildRegistry(
            asArray(handler.extractNestedValue(biosRegistryResponse, 'RegistryEntries_Attributes', '_', [])),
          );
        }
      }
    }
  }

  override async setTee(handler: RedfishTeeHandler, newSetting: boolean): Promise<boolean> {
    let settings: Record<string, number | string> = {};

    if (newSetting) {
      settings = {
        ProcVirtualization: 'Enabled',
      };
      if (!(await handler.applySequentialBiosSettings(settings))) {
        return false;
      }

      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }

      settings = {
        CpuPaLimit: 'Disabled',
        TpmSecurity: 'On',
        IntelTxt: 'On',
        ProcX2Apic: 'Enabled',
        MemOpMode: 'OptimizerMode',
      };
      if (!(await handler.applySequentialBiosSettings(settings))) {
        return false;
      }

      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }

      settings = {
        MemoryEncryption: 'MultipleKeys',
      };
      if (!(await handler.applySequentialBiosSettings(settings))) {
        return false;
      }

      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }

      settings = {
        EnableTdx: 'Enabled',
        EnableTmeBypass: 'Enabled',
      };
      if (!(await handler.applySequentialBiosSettings(settings))) {
        return false;
      }

      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }

      settings = {
        EnableTdxSeamldr: 'Enabled',
        IntelSgx: 'On',
        SgxAutoRegistrationAgent: 'Enabled',
        SgxPackageInfoInBandAccess: 'On',
        SriovGlobalEnable: 'Enabled',
        GlbMemIntegrity: 'Disabled',
      };
      if (!(await handler.applySequentialBiosSettings(settings))) {
        return false;
      }
    } else {
      settings = {
        SriovGlobalEnable: 'Disabled',
        SgxPackageInfoInBandAccess: 'Off',
        SgxAutoRegistrationAgent: 'Disabled',
        IntelSgx: 'Off',
        EnableTdxSeamldr: 'Disabled',
      };
      if (!(await handler.applySequentialBiosSettings(settings))) {
        return false;
      }

      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }

      settings = {
        EnableTmeBypass: 'Disabled',
        EnableTdx: 'Disabled',
      };
      if (!(await handler.applySequentialBiosSettings(settings))) {
        return false;
      }

      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }

      settings = {
        MemoryEncryption: 'Disabled',
      };
      if (!(await handler.applySequentialBiosSettings(settings))) {
        return false;
      }

      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }

      settings = {
        CpuPaLimit: 'Enabled',
      };
      if (!(await handler.applySequentialBiosSettings(settings))) {
        return false;
      }

      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }

      settings = {
        GlbMemIntegrity: 'Enabled',
      };
      if (!(await handler.applySequentialBiosSettings(settings))) {
        return false;
      }

      if (handler.device.rebootNeeded) {
        await handler.reboot();
      }

      settings = {
        IntelTxt: 'Off',
        TpmSecurity: 'Off',
      };
      if (!(await handler.applySequentialBiosSettings(settings))) {
        return false;
      }
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

  override verifyTee(handler: RedfishTeeHandler) {
    return Promise.resolve(
      handler.verifyBiosSettings([
        ['', 'EnableTdx', ['Enabled']],
        ['', 'MemoryEncryption', ['MultipleKeys']],
        ['', 'EnableTdxSeamldr', ['Enabled']],
        ['', 'IntelSgx', ['On', 'Enabled']],
      ]),
    );
  }

  override async preBootTweaks(handler: RedfishBootHandler): Promise<void> {
    await handler.setBiosParam('IscsiF1F2ErrorPrompt', 'Disabled');
    await handler.setBiosParam('SecurityFreezeLock', 'Disabled');
    if (handler.device.rebootNeeded) {
      await handler.reboot();
    }
  }

  override findActiveInterfaces(handler: RedfishBootHandler): Promise<JsonRecord[]> {
    return filterLinkUpEthernetInterfaces(handler, handler.device.systemEndpoint);
  }

  override async setPxeInterface(handler: RedfishBootHandler): Promise<void> {
    const interfaces = await handler.findActiveInterfaces();

    const first = interfaces[0];
    if (first !== undefined) {
      // Raise on missing / non-string @odata.id rather than PATCHing the BMC
      // with an empty interface slug.
      if (!isRecord(first) || !('@odata.id' in first)) throw new RecordKeyError('@odata.id');
      const odataIdRaw = first['@odata.id'];
      if (typeof odataIdRaw !== 'string') {
        throw new PropertyAccessError(
          `cannot read property 'split' of ${odataIdRaw === null ? 'null' : typeof odataIdRaw}`,
        );
      }
      const interfaceSlug = odataIdRaw.split('/').pop() ?? '';
      await handler.setBiosParam('PxeDev1Interface', interfaceSlug);
      await handler.setBiosParam('PxeDev1Protocol', 'IPv4');
      await handler.setBiosParam('PxeDev1VlanEnDis', 'Disabled');
    }
  }

  override setBootPxe(handler: RedfishBootHandler): Promise<void> {
    return patchStandardPxeBootOverride(handler);
  }

  override async setIpmi(handler: RedfishBootHandler, newSetting: boolean): Promise<void> {
    if (!handler.device.managerEndpoint) {
      logger.error("Can't apply new parameters, failed to determine the Manager endpoint", {
        jobId: handler.jobId,
        appClassName: APP_CLASS,
      });
      return;
    }

    if (!handler.device.networkEndpoint) {
      const managerResponse = await handler.fetch('GET', handler.device.managerEndpoint, {});
      const dellExtract = handler.extractString(managerResponse, 'NetworkProtocol_@odata.id');
      handler.device.networkEndpoint = dellExtract ?? '';
    }

    let response = await handler.fetch('GET', handler.device.networkEndpoint, {});
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

    response = await handler.fetch('PATCH', handler.device.networkEndpoint, { IPMI: { ProtocolEnabled: newSetting } });

    const rawMessage = handler.extractString(response, '@Message.ExtendedInfo_0_Message');
    if (rawMessage === null) {
      return;
    }
    const message = rawMessage.toLowerCase();

    if (message.includes('successfully completed') || message.includes('completed successfully')) {
      logger.warning(`IPMI is now ${newSetting ? 'enabled' : 'disabled'}`, {
        jobId: handler.jobId,
        appClassName: APP_CLASS,
      });

      if (message.includes('reset')) {
        handler.device.rebootNeeded = true;
        logger.info('IPMI setting change requires a reboot to take effect', {
          jobId: handler.jobId,
          appClassName: APP_CLASS,
        });
      }

      return;
    }

    logger.info(`failed to set IPMI setting: ${message}`, { jobId: handler.jobId, appClassName: APP_CLASS });
  }
}

registerVendorProfile(new DellVendorProfile());
