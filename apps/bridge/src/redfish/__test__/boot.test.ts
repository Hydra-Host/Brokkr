import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JsonRecord, RedfishHttpResponse, RedfishRequestParams } from '../vendor/base/base.js';
import { logger, RedfishDevice } from '../vendor/base/base.js';
import { RedfishBootHandler } from '../vendor/base/boot.js';

interface FetchCall {
  method: string;
  endpoint: string;
  payload: JsonRecord;
}

interface Harness {
  device: RedfishDevice;
  handler: RedfishBootHandler;
  queue: (response: JsonRecord) => void;
  calls: FetchCall[];
}

function buildDevice(vendor = 'dell', controller = 'idrac9', model = 'r740'): RedfishDevice {
  const device = new RedfishDevice('test-job', 'dev-1', '10.0.0.1', 'root', 'pw');
  device.vendor = vendor;
  device.controller = controller;
  device.model = model;
  device.systemEndpoint = '/redfish/v1/Systems/System.Embedded.1';
  device.managerEndpoint = '/redfish/v1/Managers/iDRAC.Embedded.1';
  device.chassisEndpoint = '/redfish/v1/Chassis/System.Embedded.1';
  device.accountserviceEndpoint = '/redfish/v1/AccountService';
  device.biosPatchEndpoint = '/redfish/v1/Systems/System.Embedded.1/Bios/Settings';
  device.biosGetEndpoint = '/redfish/v1/Systems/System.Embedded.1/Bios';
  device.rebootEndpoint = '/redfish/v1/Systems/System.Embedded.1/Actions/ComputerSystem.Reset';
  device.securebootEndpoint = '/redfish/v1/Systems/System.Embedded.1/SecureBoot';
  return device;
}

function buildHarness(vendor?: string, controller?: string, model?: string): Harness {
  const device = buildDevice(vendor, controller, model);
  const handler = new RedfishBootHandler(device, 'test-job');
  const queued: JsonRecord[] = [];
  const calls: FetchCall[] = [];
  vi.spyOn(handler, 'fetch').mockImplementation(async (method, endpoint, payload) => {
    calls.push({ method, endpoint, payload });
    return queued.shift() ?? {};
  });
  return { device, handler, queue: (r) => queued.push(r), calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('reliableBoot dispatch', () => {
  it('aivres runs preconditions then reboots when needed', async () => {
    const h = buildHarness('aivres', 'ast2600', 'kr6288-x2-a0-r0-00');
    h.device.rebootNeeded = true;
    const ipmi = vi.spyOn(h.handler, 'setIpmi').mockResolvedValue();
    const bootPxe = vi.spyOn(h.handler, 'setBootPxe').mockResolvedValue();
    const pxeIface = vi.spyOn(h.handler, 'setPxeInterface').mockResolvedValue();
    const setBios = vi.spyOn(h.handler, 'setBiosParam').mockResolvedValue(true);
    const reboot = vi.spyOn(h.handler, 'reboot').mockResolvedValue();

    await h.handler.reliableBoot();

    expect(ipmi).toHaveBeenCalledWith(true);
    expect(bootPxe).toHaveBeenCalled();
    expect(pxeIface).toHaveBeenCalled();
    expect(setBios).toHaveBeenCalledWith('Fixed Boot Order Control', 'Disabled', 'Setup');
    expect(reboot).toHaveBeenCalled();
  });

  it('aivres skips reboot when not needed', async () => {
    const h = buildHarness('aivres', 'openbmc', 'kr9288x3');
    h.device.rebootNeeded = false;
    vi.spyOn(h.handler, 'setIpmi').mockResolvedValue();
    vi.spyOn(h.handler, 'setBootPxe').mockResolvedValue();
    vi.spyOn(h.handler, 'setPxeInterface').mockResolvedValue();
    vi.spyOn(h.handler, 'setBiosParam').mockResolvedValue(true);
    const reboot = vi.spyOn(h.handler, 'reboot').mockResolvedValue();

    await h.handler.reliableBoot();

    expect(reboot).not.toHaveBeenCalled();
  });

  it('dell idrac9 sets the two iSCSI/SecurityFreeze params and reboots', async () => {
    const h = buildHarness('dell', 'idrac9', 'r740');
    h.device.rebootNeeded = true;
    vi.spyOn(h.handler, 'setIpmi').mockResolvedValue();
    vi.spyOn(h.handler, 'setBootPxe').mockResolvedValue();
    vi.spyOn(h.handler, 'setPxeInterface').mockResolvedValue();
    const setBios = vi.spyOn(h.handler, 'setBiosParam').mockResolvedValue(true);
    const reboot = vi.spyOn(h.handler, 'reboot').mockResolvedValue();

    await h.handler.reliableBoot();

    const keys = setBios.mock.calls.map((call) => call[0]);
    expect(keys).toContain('IscsiF1F2ErrorPrompt');
    expect(keys).toContain('SecurityFreezeLock');
    expect(reboot).toHaveBeenCalled();
  });

  it('dell idrac9 skips reboot when not needed', async () => {
    const h = buildHarness('dell', 'idrac9', 'r760xa');
    h.device.rebootNeeded = false;
    vi.spyOn(h.handler, 'setIpmi').mockResolvedValue();
    vi.spyOn(h.handler, 'setBootPxe').mockResolvedValue();
    vi.spyOn(h.handler, 'setPxeInterface').mockResolvedValue();
    vi.spyOn(h.handler, 'setBiosParam').mockResolvedValue(true);
    const reboot = vi.spyOn(h.handler, 'reboot').mockResolvedValue();

    await h.handler.reliableBoot();

    expect(reboot).not.toHaveBeenCalled();
  });

  it('unknown vendor composes preconditions but does not reboot', async () => {
    const h = buildHarness('hp', 'ilo4', '');
    h.device.rebootNeeded = true;
    vi.spyOn(h.handler, 'setIpmi').mockResolvedValue();
    vi.spyOn(h.handler, 'setBootPxe').mockResolvedValue();
    vi.spyOn(h.handler, 'setPxeInterface').mockResolvedValue();
    const reboot = vi.spyOn(h.handler, 'reboot').mockResolvedValue();

    await h.handler.reliableBoot();

    expect(reboot).not.toHaveBeenCalled();
  });
});

describe('findActiveInterfaces', () => {
  it('aivres returns adapters whose ports are Up', async () => {
    const h = buildHarness('aivres', 'ast2600', 'kr6288');
    h.queue({ Members: [{ '@odata.id': '/redfish/v1/Chassis/1/NetworkAdapters/1' }] });
    h.queue({ NetworkPorts: { '@odata.id': '/redfish/v1/Chassis/1/NetworkAdapters/1/NetworkPorts' }, Id: '1' });
    h.queue({ LinkStatus: 'Up' });

    const result = await h.handler.findActiveInterfaces();

    expect(result.length).toBe(1);
    expect(result[0]?.Id).toBe('1');
  });

  it('aivres skips Down ports', async () => {
    const h = buildHarness('aivres', 'ast2600', 'kr6288');
    h.queue({ Members: [{ '@odata.id': '/a/1' }] });
    h.queue({ NetworkPorts: { '@odata.id': '/a/1/np' }, Id: '1' });
    h.queue({ LinkStatus: 'Down' });

    const result = await h.handler.findActiveInterfaces();

    expect(result).toEqual([]);
  });

  it('cisco cbmc filters to LinkUp interfaces', async () => {
    const h = buildHarness('cisco', 'cbmc', 'cai-845a-m8');
    h.queue({ EthernetInterfaces: { '@odata.id': '/redfish/v1/Managers/CIMC/EthernetInterfaces' } });
    h.queue({
      Members: [
        { LinkStatus: 'LinkUp', Id: '1' },
        { LinkStatus: 'LinkDown', Id: '2' },
      ],
    });

    const result = await h.handler.findActiveInterfaces();

    expect(result.map((m) => m.Id)).toEqual(['1']);
  });

  it('cisco missing EthernetInterfaces endpoint returns empty', async () => {
    const h = buildHarness('cisco', 'cbmc', 'cai-845a-m8');
    h.queue({});

    const result = await h.handler.findActiveInterfaces();

    expect(result).toEqual([]);
  });

  it('dell idrac9 filters to LinkUp', async () => {
    const h = buildHarness('dell', 'idrac9', 'r740');
    h.queue({ EthernetInterfaces: { '@odata.id': '/redfish/v1/Systems/x/EthernetInterfaces' } });
    h.queue({ Members: [{ LinkStatus: 'LinkUp', '@odata.id': '/eth/NIC.1' }] });

    const result = await h.handler.findActiveInterfaces();

    expect(result.length).toBe(1);
  });

  it('dell missing endpoint returns empty', async () => {
    const h = buildHarness('dell', 'idrac9', 'r740');
    h.queue({});

    const result = await h.handler.findActiveInterfaces();

    expect(result).toEqual([]);
  });

  it('unknown vendor returns empty', async () => {
    const h = buildHarness('supermicro', 'aspeed', 'x10');

    const result = await h.handler.findActiveInterfaces();

    expect(result).toEqual([]);
  });
});

describe('setPxeInterface', () => {
  it('dell with interfaces sets three PXE bios params', async () => {
    const h = buildHarness('dell', 'idrac9', 'r740');
    vi.spyOn(h.handler, 'findActiveInterfaces').mockResolvedValue([
      { '@odata.id': '/redfish/v1/Systems/X/EthernetInterfaces/NIC.Integrated.1-1-1' },
    ]);
    const setBios = vi.spyOn(h.handler, 'setBiosParam').mockResolvedValue(true);

    await h.handler.setPxeInterface();

    const keys = setBios.mock.calls.map((call) => call[0]);
    expect(keys).toContain('PxeDev1Interface');
    expect(keys).toContain('PxeDev1Protocol');
    expect(keys).toContain('PxeDev1VlanEnDis');
  });

  it('dell with no interfaces skips', async () => {
    const h = buildHarness('dell', 'idrac9', 'r740');
    vi.spyOn(h.handler, 'findActiveInterfaces').mockResolvedValue([]);
    const setBios = vi.spyOn(h.handler, 'setBiosParam').mockResolvedValue(true);

    await h.handler.setPxeInterface();

    expect(setBios).not.toHaveBeenCalled();
  });

  it('unknown vendor logs warning, no PATCH', async () => {
    const h = buildHarness('hp', 'ilo4', '');
    vi.spyOn(h.handler, 'findActiveInterfaces').mockResolvedValue([]);

    await h.handler.setPxeInterface();

    expect(h.calls).toEqual([]);
  });
});

describe('setBootPxe', () => {
  it('dell PATCHes UEFI Continuous Pxe', async () => {
    const h = buildHarness('dell', 'idrac9', 'r740');

    await h.handler.setBootPxe();

    const last = h.calls[h.calls.length - 1];
    expect(last?.method).toBe('PATCH');
    expect(last?.endpoint).toBe(h.device.systemEndpoint);
    const boot = (last?.payload['Boot'] ?? {}) as JsonRecord;
    expect(boot['BootSourceOverrideTarget']).toBe('Pxe');
    expect(boot['BootSourceOverrideMode']).toBe('UEFI');
    expect(boot['BootSourceOverrideEnabled']).toBe('Continuous');
  });

  it('aivres ast2600 sets bios params then PATCHes system', async () => {
    const h = buildHarness('aivres', 'ast2600', 'kr6288');
    const setBios = vi.spyOn(h.handler, 'setBiosParam').mockResolvedValue(true);

    await h.handler.setBootPxe();

    const keys = setBios.mock.calls.map((call) => call[0]);
    expect(keys).toContain('Ipv4Pxe');
    expect(keys).toContain('Ipv6Pxe');
    expect(keys).toContain('UefiPriorities');
    const patch = h.calls.find((c) => c.method === 'PATCH');
    expect((patch?.payload['Boot'] as JsonRecord)?.['BootSourceOverrideTarget']).toBe('Pxe');
  });

  it('lenovo xcc3 chooses Continuous when allowed', async () => {
    const h = buildHarness('lenovo', 'xcc3', 'sr675');
    h.queue({ Boot: { 'BootSourceOverrideEnabled@Redfish.AllowableValues': ['Continuous', 'Once', 'Disabled'] } });
    vi.spyOn(h.handler, 'setBiosParam').mockResolvedValue(true);

    await h.handler.setBootPxe();

    const patch = h.calls.find((c) => c.method === 'PATCH');
    expect((patch?.payload['Boot'] as JsonRecord)?.['BootSourceOverrideEnabled']).toBe('Continuous');
  });

  it('lenovo xcc3 falls back to Once when Continuous absent', async () => {
    const h = buildHarness('lenovo', 'xcc3', 'sr675');
    h.queue({ Boot: { 'BootSourceOverrideEnabled@Redfish.AllowableValues': ['Once', 'Disabled'] } });
    vi.spyOn(h.handler, 'setBiosParam').mockResolvedValue(true);

    await h.handler.setBootPxe();

    const patch = h.calls.find((c) => c.method === 'PATCH');
    expect((patch?.payload['Boot'] as JsonRecord)?.['BootSourceOverrideEnabled']).toBe('Once');
  });

  it('supermicro PATCHes UEFI Continuous Pxe', async () => {
    const h = buildHarness('supermicro', 'aspeed', 'sys-2029tp-hc1r');

    await h.handler.setBootPxe();

    const last = h.calls[h.calls.length - 1];
    expect(last?.method).toBe('PATCH');
    const boot = (last?.payload['Boot'] ?? {}) as JsonRecord;
    expect(boot['BootSourceOverrideTarget']).toBe('Pxe');
    expect(boot['BootSourceOverrideMode']).toBe('UEFI');
  });

  it('unknown vendor is a no-op', async () => {
    const h = buildHarness('hp', 'ilo4', '');

    await h.handler.setBootPxe();

    expect(h.calls).toEqual([]);
  });
});

describe('setIpmi', () => {
  it('aivres skips when already enabled', async () => {
    const h = buildHarness('aivres', 'ast2600', 'kr6288');
    h.queue({ NetworkProtocol: { '@odata.id': '/redfish/v1/Managers/1/NetworkProtocol' } });
    h.queue({ IPMI: { ProtocolEnabled: true } });

    await h.handler.setIpmi(true);

    const patches = h.calls.filter((c) => c.method === 'PATCH');
    expect(patches).toEqual([]);
  });

  it('aivres patches when needs enable', async () => {
    const h = buildHarness('aivres', 'ast2600', 'kr6288');
    h.queue({ NetworkProtocol: { '@odata.id': '/redfish/v1/Managers/1/NetworkProtocol' } });
    h.queue({ IPMI: { ProtocolEnabled: false } });
    h.queue({});

    await h.handler.setIpmi(true);

    const patches = h.calls.filter((c) => c.method === 'PATCH');
    expect(patches.length).toBe(1);
    expect(patches[0]?.payload).toEqual({ IPMI: { ProtocolEnabled: true } });
  });

  it('aivres missing ProtocolEnabled returns without patch', async () => {
    const h = buildHarness('aivres', 'ast2600', 'kr6288');
    h.queue({ NetworkProtocol: { '@odata.id': '/x' } });
    h.queue({ IPMI: {} });

    await h.handler.setIpmi(true);

    const patches = h.calls.filter((c) => c.method === 'PATCH');
    expect(patches).toEqual([]);
  });

  it('dell missing manager endpoint returns', async () => {
    const h = buildHarness('dell', 'idrac9', 'r740');
    h.device.managerEndpoint = '';

    await h.handler.setIpmi(true);

    expect(h.calls).toEqual([]);
  });

  it('dell patches then flags reboot when message includes "reset"', async () => {
    const h = buildHarness('dell', 'idrac9', 'r740');
    h.queue({ NetworkProtocol: { '@odata.id': '/redfish/v1/Managers/iDRAC/NetworkProtocol' } });
    h.queue({ IPMI: { ProtocolEnabled: false } });
    h.queue({ '@Message.ExtendedInfo': [{ Message: 'Successfully completed. Please reset.' }] });

    await h.handler.setIpmi(true);

    expect(h.device.rebootNeeded).toBe(true);
  });

  it('dell no message short-circuits without flagging reboot', async () => {
    const h = buildHarness('dell', 'idrac9', 'r740');
    h.queue({ NetworkProtocol: { '@odata.id': '/redfish/v1/Managers/iDRAC/NetworkProtocol' } });
    h.queue({ IPMI: { ProtocolEnabled: false } });
    h.queue({});

    await h.handler.setIpmi(true);

    expect(h.device.rebootNeeded).toBe(false);
  });

  it('dell already-enabled short-circuits patch', async () => {
    const h = buildHarness('dell', 'idrac9', 'r740');
    h.queue({ NetworkProtocol: { '@odata.id': '/redfish/v1/Managers/iDRAC/NetworkProtocol' } });
    h.queue({ IPMI: { ProtocolEnabled: true } });

    await h.handler.setIpmi(true);

    const patches = h.calls.filter((c) => c.method === 'PATCH');
    expect(patches).toEqual([]);
  });

  it('dell resolves NetworkProtocol via manager when network endpoint missing', async () => {
    const h = buildHarness('dell', 'idrac9', 'r740');
    h.device.networkEndpoint = '';
    h.queue({ NetworkProtocol: { '@odata.id': '/redfish/v1/Managers/iDRAC/NetworkProtocol' } });
    h.queue({ IPMI: { ProtocolEnabled: false } });
    h.queue({ '@Message.ExtendedInfo': [{ Message: 'completed successfully' }] });

    await h.handler.setIpmi(true);

    expect(h.device.networkEndpoint).toBe('/redfish/v1/Managers/iDRAC/NetworkProtocol');
  });

  it('lenovo password-reset PATCH never logs the cleartext password', async () => {
    const SECRET = 'lenovo-bmc-secret';
    const device = buildDevice('lenovo', 'xcc3', 'x');
    device.username = 'root';
    device.password = SECRET;
    device.networkEndpoint = '/redfish/v1/Managers/1/NetworkProtocol';

    const reply = (obj: JsonRecord): RedfishHttpResponse => ({ status: 200, text: JSON.stringify(obj), headers: {} });
    const requester = vi.fn(async ({ method, url }: RedfishRequestParams): Promise<RedfishHttpResponse> => {
      if (method === 'GET' && url.includes('/NetworkProtocol')) return reply({ IPMI: { ProtocolEnabled: false } });
      if (method === 'GET' && url.endsWith('/AccountService'))
        return reply({ Accounts: { '@odata.id': '/redfish/v1/AccountService/Accounts' } });
      if (method === 'GET' && url.endsWith('/Accounts'))
        return reply({ Members: [{ '@odata.id': '/redfish/v1/AccountService/Accounts/2' }] });
      if (method === 'GET' && url.endsWith('/Accounts/2'))
        return reply({ UserName: 'root', AccountTypes: ['Redfish'] });
      return reply({ '@Message.ExtendedInfo': [{ Message: 'completed successfully' }] });
    });
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const handler = new RedfishBootHandler(device, 'test-job', requester);

    await handler.setIpmi(true);

    const lines = debug.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('"Password":"********"'))).toBe(true);
    expect(lines.every((l) => !l.includes(SECRET))).toBe(true);
    const pwBody = requester.mock.calls.map((c) => c[0].body).find((b) => b?.includes('"Password"'));
    expect(pwBody).toContain(SECRET);
  });
});
