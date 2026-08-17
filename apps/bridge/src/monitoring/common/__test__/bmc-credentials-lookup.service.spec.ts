import { describe, expect, it, vi } from 'vitest';

import { bmcCredentials } from '../../../common/bmc.types';
import type { ActiveDevicesCache } from '../active-devices.service';
import {
  AtomBmcCredentialsLookup,
  StaticBmcCredentialsLookup,
  type BmcSecretSource,
  type OpenedBmcSecret,
} from '../bmc-credentials-lookup.service';

interface DeviceDataMap {
  [deviceId: string]: Record<string, unknown>;
}

function fakeDataCache(deviceData: DeviceDataMap = {}): ActiveDevicesCache {
  return {
    scan: vi.fn(async () => []),
    get: vi.fn(async (key: string) => {
      const id = key.split(':')[1];
      const blob = deviceData[id];
      return blob === undefined ? null : JSON.stringify(blob);
    }),
  };
}

function fakeSecretSource(secrets: { [deviceId: string]: OpenedBmcSecret | null }): BmcSecretSource {
  return {
    getBmcSecret: vi.fn(async (deviceId: string) => secrets[deviceId] ?? null),
  };
}

function deviceDataWithBmc(ip: string) {
  return { interfaces: [{ mgmt_only: true, ip_addresses: [{ address: `${ip}/24` }] }] };
}

describe('StaticBmcCredentialsLookup', () => {
  it('returns creds for known device', async () => {
    const creds = bmcCredentials('10.0.0.1', 'USERID', 'secret');
    const lookup = new StaticBmcCredentialsLookup({ '42': creds });
    expect(await lookup.get('42')).toEqual(creds);
  });

  it('returns null for unknown device', async () => {
    const lookup = new StaticBmcCredentialsLookup({});
    expect(await lookup.get('nope')).toBeNull();
  });

  it('table is defensively copied (Map mutation does not leak)', async () => {
    const creds = bmcCredentials('10.0.0.1', 'u', 'p');
    const source = new Map<string, ReturnType<typeof bmcCredentials>>([['42', creds]]);
    const lookup = new StaticBmcCredentialsLookup(source);
    source.clear();
    expect(await lookup.get('42')).toEqual(creds);
  });

  it('getIp returns the table IP or null', async () => {
    const lookup = new StaticBmcCredentialsLookup({ '42': bmcCredentials('10.0.0.1', 'u', 'p') });
    expect(await lookup.getIp('42')).toBe('10.0.0.1');
    expect(await lookup.getIp('nope')).toBeNull();
  });
});

describe('AtomBmcCredentialsLookup', () => {
  it('requests the BMC/USER secret for the device', async () => {
    const source = fakeSecretSource({ '42': { username: 'USERID', password: 'secret' } });
    const lookup = new AtomBmcCredentialsLookup(
      source,
      fakeDataCache({ '42': deviceDataWithBmc('10.0.0.1') }),
      'job-1',
    );
    await lookup.get('42');
    expect(source.getBmcSecret).toHaveBeenCalledWith('42', 'BMC', 'USER', { jobId: 'job-1' });
  });

  it('returns creds when secret and bmc_ip both present', async () => {
    const source = fakeSecretSource({ '42': { username: 'USERID', password: 'secret' } });
    const lookup = new AtomBmcCredentialsLookup(source, fakeDataCache({ '42': deviceDataWithBmc('10.0.0.1') }));
    expect(await lookup.get('42')).toEqual(bmcCredentials('10.0.0.1', 'USERID', 'secret'));
  });

  it('null secret (atom never rendered) returns null', async () => {
    const source = fakeSecretSource({ '42': null });
    const lookup = new AtomBmcCredentialsLookup(source, fakeDataCache({ '42': deviceDataWithBmc('10.0.0.1') }));
    expect(await lookup.get('42')).toBeNull();
  });

  it('empty-string username returns null', async () => {
    const source = fakeSecretSource({ '42': { username: '', password: 'secret' } });
    const lookup = new AtomBmcCredentialsLookup(source, fakeDataCache({ '42': deviceDataWithBmc('10.0.0.1') }));
    expect(await lookup.get('42')).toBeNull();
  });

  it('empty-string password returns null', async () => {
    const source = fakeSecretSource({ '42': { username: 'USERID', password: '' } });
    const lookup = new AtomBmcCredentialsLookup(source, fakeDataCache({ '42': deviceDataWithBmc('10.0.0.1') }));
    expect(await lookup.get('42')).toBeNull();
  });

  it('missing device data returns null', async () => {
    const source = fakeSecretSource({ '42': { username: 'USERID', password: 'secret' } });
    const lookup = new AtomBmcCredentialsLookup(source, fakeDataCache({}));
    expect(await lookup.get('42')).toBeNull();
  });

  it('device data without mgmt interface returns null', async () => {
    const source = fakeSecretSource({ '42': { username: 'USERID', password: 'secret' } });
    const lookup = new AtomBmcCredentialsLookup(
      source,
      fakeDataCache({ '42': { interfaces: [{ mgmt_only: false, ip_addresses: [{ address: '10.0.0.1/24' }] }] } }),
    );
    expect(await lookup.get('42')).toBeNull();
  });

  it('does not fetch device data when the secret is missing', async () => {
    const source = fakeSecretSource({ '42': null });
    const dataCache = fakeDataCache({ '42': deviceDataWithBmc('10.0.0.1') });
    const lookup = new AtomBmcCredentialsLookup(source, dataCache);
    expect(await lookup.get('42')).toBeNull();
    expect(dataCache.get).not.toHaveBeenCalled();
  });

  it('getIp resolves the mgmt IP without touching the secret source (PDU/CDU have no sealed secret)', async () => {
    const source = fakeSecretSource({});
    const lookup = new AtomBmcCredentialsLookup(source, fakeDataCache({ 'pdu-1': deviceDataWithBmc('10.4.0.2') }));
    expect(await lookup.getIp('pdu-1')).toBe('10.4.0.2');
    expect(source.getBmcSecret).not.toHaveBeenCalled();
  });

  it('getIp returns null when the device data or mgmt IP is missing', async () => {
    const lookup = new AtomBmcCredentialsLookup(fakeSecretSource({}), fakeDataCache({}));
    expect(await lookup.getIp('ghost')).toBeNull();
  });
});
