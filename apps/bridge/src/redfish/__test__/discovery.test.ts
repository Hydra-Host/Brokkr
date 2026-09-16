import { afterEach, describe, expect, it, vi } from 'vitest';

import { JsonRecord, RedfishDevice } from '../vendor/base/base.js';
import { RedfishDiscoveryHandler } from '../vendor/base/discovery.js';
import {
  discoverSupermicroTeeHandler,
  FakeSupermicroBmc,
  SUPERMICRO_BIOS_PATH,
  SUPERMICRO_REGISTRY_URI,
  SUPERMICRO_SD_PATH,
} from './supermicro-tee.testutil.js';

delete process.env.BROKKR_ENV;
delete process.env.HH_ENV;
delete process.env.ENVIRONMENT;

type Blob = Record<string, JsonRecord>;

function makeHandler(blob: Blob): { handler: RedfishDiscoveryHandler; queried: string[] } {
  const device = new RedfishDevice('test-job', 'dev-1', '10.0.0.1', 'u', 'p');
  const handler = new RedfishDiscoveryHandler(device, 'test-job');
  const queried: string[] = [];
  vi.spyOn(handler, 'fetch').mockImplementation((_method: string, endpoint: string) => {
    queried.push(endpoint);
    const bare = endpoint.split('?')[0] ?? endpoint;
    return Promise.resolve(blob[endpoint] ?? blob[bare] ?? {});
  });
  return { handler, queried };
}

function registryBlob(attributes: JsonRecord[]): JsonRecord {
  return { RegistryEntries: { Attributes: attributes } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('service-root bootstrap', () => {
  it('returns early when /redfish gives no response', async () => {
    const { handler, queried } = makeHandler({});

    await handler.discover();

    expect(handler.device.redfishEndpoint).toBe('');
    expect(queried).toEqual(['/redfish']);
  });

  it('falls back to /redfish/v1 when the v1 pointer is missing', async () => {
    const { handler } = makeHandler({
      '/redfish': { name: 'Redfish' },
      '/redfish/v1': { Vendor: 'Test', Systems: { '@odata.id': '/redfish/v1/Systems' }, Oem: {} },
      '/redfish/v1/Systems': { Members: [{ '@odata.id': '/redfish/v1/Systems/1' }] },
      '/redfish/v1/Systems/1': {},
    });

    await handler.discover();

    expect(handler.device.redfishEndpoint).toBe('/redfish/v1');
    expect(handler.device.vendor).toBe('test');
  });

  it('retries the service root with a trailing slash', async () => {
    const { handler, queried } = makeHandler({
      '/redfish': { v1: '/redfish/v1' },
      '/redfish/v1': {},
      '/redfish/v1/': { Vendor: 'Probe', Systems: { '@odata.id': '/redfish/v1/Systems' }, Oem: {} },
      '/redfish/v1/Systems': { Members: [{ '@odata.id': '/redfish/v1/Systems/1' }] },
      '/redfish/v1/Systems/1': {},
    });

    await handler.discover();

    expect(handler.device.redfishEndpoint).toBe('/redfish/v1/');
    expect(handler.device.vendor).toBe('probe');
    expect(queried).toContain('/redfish/v1');
    expect(queried).toContain('/redfish/v1/');
  });

  it('clears the endpoint when the service root never responds', async () => {
    const { handler } = makeHandler({ '/redfish': { v1: '/redfish/v1' } });

    await handler.discover();

    expect(handler.device.redfishEndpoint).toBe('');
  });

  it('captures jobservice, accountservice and registries endpoints from the service root', async () => {
    const { handler } = makeHandler({
      '/redfish': { v1: '/redfish/v1' },
      '/redfish/v1': {
        Vendor: 'Generic',
        Oem: {},
        Systems: { '@odata.id': '/redfish/v1/Systems' },
        JobService: { '@odata.id': '/redfish/v1/JobService' },
        AccountService: { '@odata.id': '/redfish/v1/AccountService' },
        Registries: { '@odata.id': '/redfish/v1/Registries' },
      },
      '/redfish/v1/Systems': { Members: [] },
      '/redfish/v1/JobService': { Jobs: { '@odata.id': '/redfish/v1/JobService/Jobs' } },
    });

    await handler.discover();

    expect(handler.device.jobserviceEndpoint).toBe('/redfish/v1/JobService/Jobs');
    expect(handler.device.accountserviceEndpoint).toBe('/redfish/v1/AccountService');
    expect(handler.device.registriesEndpoint).toBe('/redfish/v1/Registries');
    expect(handler.device.systemEndpoint).toBe('');
  });
});

describe('vendor resolution ladder', () => {
  function rootOnly(root: JsonRecord): Blob {
    return {
      '/redfish': { v1: '/redfish/v1' },
      '/redfish/v1': { ...root, Systems: { '@odata.id': '/redfish/v1/Systems' } },
      '/redfish/v1/Systems': { Members: [] },
    };
  }

  it.each([
    [{ Vendor: 'Cisco Systems Inc', Oem: {} }, 'cisco systems inc'],
    [{ Manufacturer: 'Lenovo', Oem: {} }, 'lenovo'],
    [{ Oem: { Hp: {} } }, 'hp'],
    [{ Oem: { Public: { Manufacturer: 'AIVRES' } } }, 'aivres'],
    [{ Oem: {} }, 'null'],
  ])('resolves %j to vendor %s', async (root, vendor) => {
    const { handler } = makeHandler(rootOnly(root));

    await handler.discover();

    expect(handler.device.vendor).toBe(vendor);
  });
});

describe('dell discovery walk', () => {
  function dellBlob(): Blob {
    return {
      '/redfish': { v1: '/redfish/v1' },
      '/redfish/v1': {
        Vendor: 'Dell',
        Oem: {},
        Systems: { '@odata.id': '/redfish/v1/Systems' },
        Registries: { '@odata.id': '/redfish/v1/Registries' },
      },
      '/redfish/v1/Systems': { Members: [{ '@odata.id': '/redfish/v1/Systems/System.Embedded.1' }] },
      '/redfish/v1/Systems/System.Embedded.1': {
        Model: 'PowerEdge R760xa',
        BootProgress: { LastState: 'OSRunning' },
        Actions: {
          '#ComputerSystem.Reset': {
            target: '/redfish/v1/Systems/System.Embedded.1/Actions/ComputerSystem.Reset',
            'ResetType@Redfish.AllowableValues': ['On', 'ForceOff'],
          },
        },
        Links: { ManagedBy: [{ '@odata.id': '/redfish/v1/Managers/iDRAC.Embedded.1' }] },
        Bios: { '@odata.id': '/redfish/v1/Systems/System.Embedded.1/Bios' },
      },
      '/redfish/v1/Managers/iDRAC.Embedded.1': {
        Model: '14G Monolithic',
        Links: { Oem: { Dell: { Jobs: { '@odata.id': '/redfish/v1/Managers/iDRAC.Embedded.1/Oem/Dell/Jobs' } } } },
      },
      '/redfish/v1/Managers/iDRAC.Embedded.1/Oem/Dell/Jobs': {
        Members: [
          { JobState: 'Pending', Name: 'DriverFlash' },
          { JobState: 'Running', Name: 'FirmwareUpdate' },
          { NoState: true },
        ],
      },
      '/redfish/v1/Systems/System.Embedded.1/Bios': {
        Attributes: { BootMode: 'Uefi' },
        '@Redfish.Settings': { SettingsObject: { '@odata.id': '/redfish/v1/Systems/System.Embedded.1/Bios/Settings' } },
      },
      '/redfish/v1/Systems/System.Embedded.1/Bios/Settings': { Attributes: { AcPwrRcvry: 'On' } },
      '/redfish/v1/Registries': {
        Members: [
          { '@odata.id': '/redfish/v1/Registries/BaseMessages' },
          { '@odata.id': '/redfish/v1/Registries/BiosAttributeRegistry' },
        ],
      },
      '/redfish/v1/Registries/BiosAttributeRegistry': {
        Location: [{ Uri: '/redfish/v1/Registries/BiosAttributeRegistry/Locked.json' }],
      },
      '/redfish/v1/Registries/BiosAttributeRegistry/Locked.json': registryBlob([
        { AttributeName: 'AcPwrRcvry' },
        { AttributeName: 'AesNi' },
      ]),
    };
  }

  it('resolves the full idrac9 endpoint map, jobs by state, pending bios and registry', async () => {
    const { handler } = makeHandler(dellBlob());

    await handler.discover();

    const device = handler.device;
    expect(device.vendor).toBe('dell');
    expect(device.controller).toBe('idrac9');
    expect(device.model).toBe('R760xa');
    expect(device.modelFull).toBe('PowerEdge R760xa');
    expect(device.systemEndpoint).toBe('/redfish/v1/Systems/System.Embedded.1');
    expect(device.managerEndpoint).toBe('/redfish/v1/Managers/iDRAC.Embedded.1');
    expect(device.biosGetEndpoint).toBe('/redfish/v1/Systems/System.Embedded.1/Bios');
    expect(device.biosPatchEndpoint).toBe('/redfish/v1/Systems/System.Embedded.1/Bios/Settings');
    expect(device.rebootEndpoint).toBe('/redfish/v1/Systems/System.Embedded.1/Actions/ComputerSystem.Reset');
    expect(device.bootState).toBe('OSRunning');
    expect(device.bootOptions).toEqual(['On', 'ForceOff']);
    expect(device.dellLcServiceEndpoint).toBe(
      '/redfish/v1/Dell/Managers/iDRAC.Embedded.1/DellLCService/Actions/DellLCService.GetRemoteServicesAPIStatus',
    );
    expect(device.jobserviceEndpoint).toBe('/redfish/v1/Managers/iDRAC.Embedded.1/Oem/Dell/Jobs');
    expect(Object.keys(device.jobsByState).sort()).toEqual(['Pending', 'Running']);
    expect(device.rebootNeeded).toBe(true);
    expect(device.biosPendingParams).toEqual({ AcPwrRcvry: 'On' });
    expect(Object.keys(device.registry).sort()).toEqual(['AcPwrRcvry', 'AesNi']);
  });

  it('returns early from the dell branch when the manager link is missing', async () => {
    const blob = dellBlob();
    blob['/redfish/v1/Systems/System.Embedded.1'] = {
      ...blob['/redfish/v1/Systems/System.Embedded.1'],
      Links: { ManagedBy: [] },
    };
    const { handler } = makeHandler(blob);

    await handler.discover();

    expect(handler.device.managerEndpoint).toBe('');
    expect(handler.device.biosGetEndpoint).toBe('');
  });
});

describe('lenovo discovery walk', () => {
  it('derives model and controller, diffs pending bios and loads the registry', async () => {
    const { handler } = makeHandler({
      '/redfish': { v1: '/redfish/v1' },
      '/redfish/v1': { Vendor: 'Lenovo', Oem: {}, Systems: { '@odata.id': '/redfish/v1/Systems' } },
      '/redfish/v1/Systems': { Members: [{ '@odata.id': '/redfish/v1/Systems/1' }] },
      '/redfish/v1/Systems/1': {
        Model: 'ThinkSystem SR675 V3',
        PowerState: 'On',
        Actions: {
          '#ComputerSystem.Reset': {
            target: '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset',
            'ResetType@Redfish.AllowableValues': ['GracefulRestart', 'ForceRestart'],
          },
        },
        Links: {
          ManagedBy: [{ '@odata.id': '/redfish/v1/Managers/1' }],
          Chassis: [{ '@odata.id': '/redfish/v1/Chassis/1' }],
        },
        Bios: { '@odata.id': '/redfish/v1/Systems/1/Bios' },
      },
      '/redfish/v1/Systems/1/Bios': {
        Attributes: { OperatingMode: 'Efficiency', BootModes_SystemBootMode: 'UEFI Mode' },
        AttributeRegistry: 'BiosAttributeRegistry.1.0.0',
      },
      '/redfish/v1/Systems/1/Bios/Pending': {
        Attributes: { OperatingMode: 'MaximumPerformance', BootModes_SystemBootMode: 'UEFI Mode' },
      },
      '/redfish/v1/schemas/registries/BiosAttributeRegistry.1.0.0.json': registryBlob([
        { AttributeName: 'OperatingMode' },
      ]),
    });

    await handler.discover();

    const device = handler.device;
    expect(device.vendor).toBe('lenovo');
    expect(device.model).toBe('SR675');
    expect(device.controller).toBe('xcc3');
    expect(device.biosGetEndpoint).toBe('/redfish/v1/Systems/1/Bios');
    expect(device.biosPatchEndpoint).toBe('/redfish/v1/Systems/1/Bios/Pending');
    expect(device.biosPendingParams).toEqual({ OperatingMode: 'MaximumPerformance' });
    expect(device.rebootNeeded).toBe(true);
    expect(Object.keys(device.registry)).toEqual(['OperatingMode']);
  });
});

describe('supermicro discovery walk', () => {
  it('truncates the model, prefers the manager bios endpoint and builds the display-name map', async () => {
    const { handler } = makeHandler({
      '/redfish': { v1: '/redfish/v1' },
      '/redfish/v1': {
        Vendor: 'Supermicro',
        Oem: {},
        Systems: { '@odata.id': '/redfish/v1/Systems' },
        Registries: { '@odata.id': '/redfish/v1/Registries' },
      },
      '/redfish/v1/Systems': { Members: [{ '@odata.id': '/redfish/v1/Systems/1' }] },
      '/redfish/v1/Systems/1': {
        Model: 'SYS-2029TP-HC1R-EXTRA',
        PowerState: 'On',
        Actions: {
          '#ComputerSystem.Reset': {
            target: '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset',
            'ResetType@Redfish.AllowableValues': ['On', 'ForceRestart'],
          },
        },
        Links: { ManagedBy: [{ '@odata.id': '/redfish/v1/Managers/1' }] },
      },
      '/redfish/v1/Managers/1': { Model: 'ASPEED', Bios: { '@odata.id': '/redfish/v1/Managers/1/Bios' } },
      '/redfish/v1/Managers/1/Bios': {
        Attributes: { BootModeSelect: 'UEFI' },
        '@Redfish.Settings': { SettingsObject: { '@odata.id': '/redfish/v1/Managers/1/Bios/SD' } },
      },
      '/redfish/v1/Managers/1/Bios/SD': { Attributes: {} },
      '/redfish/v1/Registries': { Members: [{ '@odata.id': '/redfish/v1/Registries/BiosAttributeRegistry.v1_0_0' }] },
      '/redfish/v1/Registries/BiosAttributeRegistry.v1_0_0': {
        Location: [{ Uri: '/redfish/v1/Registries/BiosAttributeRegistry.v1_0_0/sm.json' }],
      },
      '/redfish/v1/Registries/BiosAttributeRegistry.v1_0_0/sm.json': registryBlob([
        { AttributeName: 'BootModeSelect', DisplayName: 'Boot Mode Select' },
        { AttributeName: 'InternalNoName' },
      ]),
    });

    await handler.discover();

    const device = handler.device;
    expect(device.vendor).toBe('supermicro');
    expect(device.modelFull).toBe('SYS-2029TP-HC1R');
    expect(device.model).toBe('sys-2029tp-hc1r');
    expect(device.controller).toBe('aspeed');
    expect(device.biosGetEndpoint).toBe('/redfish/v1/Managers/1/Bios');
    expect(device.biosPatchEndpoint).toBe('/redfish/v1/Managers/1/Bios/SD');
    expect(device.rebootNeeded).toBe(false);
    expect(device.displayNameToAttr).toEqual({ 'Boot Mode Select': 'BootModeSelect' });
    expect(Object.keys(device.registry).sort()).toEqual(['BootModeSelect', 'InternalNoName']);
  });

  it('walks the x14 fixture through the unversioned registry member and keeps no pending from the echo', async () => {
    const bmc = new FakeSupermicroBmc();

    const { device } = await discoverSupermicroTeeHandler(bmc);

    const paths = bmc.requests.map((request) => request.path);
    expect(device.tag()).toBe('supermicro.ast2600.sys-222ha-tn');
    expect(device.biosGetEndpoint).toBe(SUPERMICRO_BIOS_PATH);
    expect(device.biosPatchEndpoint).toBe(SUPERMICRO_SD_PATH);
    expect(paths).toContain('/redfish/v1/Registries/BiosAttributeRegistry');
    expect(paths).toContain(SUPERMICRO_REGISTRY_URI);
    expect(Object.keys(device.registry)).toHaveLength(22);
    expect(device.registry['LimitCPUPAto46bits_F319']?.['Hidden']).toBe(true);
    expect(device.displayNameToAttr?.['Trust Domain Extensions (TDX)']).toBe('TrustDomainExtensions_TDX_');
    expect(Object.keys(device.biosParams)).toHaveLength(13);
    expect(device.biosPendingParams).toEqual({});
    expect(device.rebootNeeded).toBe(false);
  });

  it('keeps only the sd values that differ from live as pending', async () => {
    const bmc = new FakeSupermicroBmc();
    bmc.pending = { MemoryEncryption_TME_: 'Enabled' };

    const { device } = await discoverSupermicroTeeHandler(bmc);

    expect(device.biosPendingParams).toEqual({ MemoryEncryption_TME_: 'Enabled' });
    expect(device.rebootNeeded).toBe(true);
  });
});

describe('unknown-vendor branch', () => {
  it('falls back to PartNumber, normalizes the controller and re-tags from bios hints', async () => {
    const { handler } = makeHandler({
      '/redfish': { v1: '/redfish/v1' },
      '/redfish/v1': { Oem: {}, Systems: { '@odata.id': '/redfish/v1/Systems' } },
      '/redfish/v1/Systems': { Members: [{ '@odata.id': '/redfish/v1/Systems/1' }] },
      '/redfish/v1/Systems/1': {
        Manufacturer: 'GenericInc',
        PartNumber: 'Widget X',
        PowerState: 'On',
        Links: { ManagedBy: [{ '@odata.id': '/redfish/v1/Managers/1' }] },
        Bios: { '@odata.id': '/redfish/v1/Systems/1/Bios' },
        Actions: {
          '#ComputerSystem.Reset': {
            target: '/redfish/v1/Reset',
            'ResetType@Redfish.AllowableValues': ['On', 'ForceOff'],
          },
        },
      },
      '/redfish/v1/Managers/1': { Model: 'Some BMC' },
      '/redfish/v1/Systems/1/Bios': {
        Attributes: { AMITSESetup: true, IntelSetup: true },
        AttributeRegistry: 'FooBios.1.0.0',
        '@Redfish.Settings': { SettingsObject: { '@odata.id': '/redfish/v1/Systems/1/Bios/Settings' } },
      },
      '/redfish/v1/Systems/1/Bios/Settings': {
        Attributes: { BootMode: 'Uefi' },
        AttributeRegistry: 'FooBios.1.0.0',
      },
      '/redfish/v1/Registries/FooBios.1.0.0.json': registryBlob([{ AttributeName: 'BootMode' }]),
    });

    await handler.discover();

    const device = handler.device;
    expect(device.vendor).toBe('ami');
    expect(device.model).toBe('intel');
    expect(device.controller).toBe('somebmc');
    expect(device.biosGetEndpoint).toBe('/redfish/v1/Systems/1/Bios');
    expect(device.rebootNeeded).toBe(true);
    expect(Object.keys(device.registry)).toEqual(['BootMode']);
  });

  it('keeps controller=unknown when no manager link exists', async () => {
    const { handler } = makeHandler({
      '/redfish': { v1: '/redfish/v1' },
      '/redfish/v1': { Oem: {}, Systems: { '@odata.id': '/redfish/v1/Systems' } },
      '/redfish/v1/Systems': { Members: [{ '@odata.id': '/redfish/v1/Systems/1' }] },
      '/redfish/v1/Systems/1': {
        Manufacturer: 'GenericInc',
        Model: 'X',
        Links: { ManagedBy: [] },
        PowerState: 'Off',
        Actions: { '#ComputerSystem.Reset': { target: '/r' } },
        Bios: { '@odata.id': '/redfish/v1/Systems/1/Bios' },
      },
      '/redfish/v1/Systems/1/Bios': { Attributes: {} },
    });

    await handler.discover();

    expect(handler.device.controller).toBe('unknown');
    expect(handler.device.vendor).toBe('genericinc');
  });
});

describe('unsupported vendor dispatch', () => {
  it('logs and returns without crashing', async () => {
    const { handler } = makeHandler({
      '/redfish': { v1: '/redfish/v1' },
      '/redfish/v1': { Vendor: 'ExotiCorp', Oem: {}, Systems: { '@odata.id': '/redfish/v1/Systems' } },
      '/redfish/v1/Systems': { Members: [{ '@odata.id': '/redfish/v1/Systems/1' }] },
      '/redfish/v1/Systems/1': { Model: 'Z1' },
    });

    await handler.discover();

    expect(handler.device.vendor).toBe('exoticorp');
    expect(handler.device.systemEndpoint).toBe('/redfish/v1/Systems/1');
  });
});
