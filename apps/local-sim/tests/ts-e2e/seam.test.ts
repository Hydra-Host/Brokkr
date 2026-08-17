import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Fleet } from './helpers';
import { HubDB } from './hub-db';
import { selectInventoryDevice } from './lifecycle-helpers';

const FLEET: Fleet = {
  mode: 'baremetal',
  network: { name: 'brokkr-net', cidr: '192.168.200.0/24', domain: 'sim', bmc_cidr: '192.168.105.0/24' },
  nodes: [],
  baremetal: null,
};

function stubHubDb(state: { lifecycleStatus: string | null }): HubDB {
  return { getServerState: vi.fn().mockResolvedValue({ ...state, deviceStatus: 'ACTIVE' }) } as unknown as HubDB;
}

describe('selectInventoryDevice — SIM_LC_DEVICE_ID (bare-metal) branch', () => {
  const BM_ID = '0e8c9981-6781-5e20-9d8e-a84ccf7f548a';

  afterEach(() => {
    delete process.env.SIM_LC_DEVICE_ID;
    delete process.env.SIM_LC_DEVICE_INDEX;
    vi.restoreAllMocks();
  });

  it('uses the explicit device id verbatim when set + INVENTORY (never the index scan)', async () => {
    process.env.SIM_LC_DEVICE_ID = BM_ID;
    const hubDb = stubHubDb({ lifecycleStatus: 'INVENTORY' });
    expect(await selectInventoryDevice(hubDb, FLEET)).toBe(BM_ID);
    expect(hubDb.getServerState).toHaveBeenCalledWith(BM_ID);
  });

  it('skips (returns null) when the explicit device is not INVENTORY', async () => {
    process.env.SIM_LC_DEVICE_ID = BM_ID;
    const hubDb = stubHubDb({ lifecycleStatus: 'PROVISIONED' });
    expect(await selectInventoryDevice(hubDb, FLEET)).toBeNull();
  });

  it('fails fast when SIM_LC_DEVICE_ID is set to a non-UUID', async () => {
    process.env.SIM_LC_DEVICE_ID = 'not-a-uuid';
    const hubDb = stubHubDb({ lifecycleStatus: 'INVENTORY' });
    await expect(selectInventoryDevice(hubDb, FLEET)).rejects.toThrow(/not a UUID/);
  });
});

describe('HubDB.getDataIpByBootMac — SQL shape + fixture row', () => {
  it('returns the fixture row data-plane IPv4', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ dataIp: '198.51.100.42' }]);
    const hubDb = new HubDB({ $queryRaw: queryRaw } as unknown as HubDB['prisma']);

    const ip = await hubDb.getDataIpByBootMac('00:00:5e:00:53:b4');
    expect(ip).toBe('198.51.100.42');

    const [strings, boundMac] = queryRaw.mock.calls[0]!;
    const sql = (strings as string[]).join('?');
    expect(boundMac).toBe('00:00:5e:00:53:b4');
    expect(sql).toMatch(/lower\(ii\."macAddress"\)\s*=\s*lower\(/i);
    expect(sql).not.toMatch(/name\s*=\s*'eth0'/i);
    expect(sql).toMatch(/ip\.status\s*=\s*'ACTIVE'/i);
    expect(sql).toMatch(/family\(ip\.address\)\s*=\s*4/i);
    expect(sql).toMatch(/ORDER BY ip\."createdAt" DESC/i);
  });

  it('returns null when no interface/IP matches (discovery not yet populated)', async () => {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const hubDb = new HubDB({ $queryRaw: queryRaw } as unknown as HubDB['prisma']);
    expect(await hubDb.getDataIpByBootMac('00:00:5e:00:53:b4')).toBeNull();
  });
});
