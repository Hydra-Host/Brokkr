import { Prisma } from '@repo/database';
import { describe, expect, it, vi } from 'vitest';
import {
  type DhcpConfigRow,
  findBootPrefixForDevice,
  readDhcpConfig,
  readProxyAllowlist,
  resolveBootIdentity,
  toDhcpConfig,
} from '../prefix-boot-queries';

const ORG = '44444444-4444-4444-4444-444444444444';
const ZONE = '11111111-1111-1111-1111-111111111111';
const DEVICE = '22222222-2222-2222-2222-222222222222';
const PREFIX = '33333333-3333-3333-3333-333333333333';
const MAC = 'aa:bb:cc:dd:ee:ff';
const BMC = '10.0.2.10';

function fakeClient(replies: unknown[][]) {
  const queries: Prisma.Sql[] = [];
  const $queryRaw = vi.fn().mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push(Prisma.sql(strings, ...values));
    return replies.shift() ?? [];
  });
  return { client: { $queryRaw }, queries };
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

const ROW: DhcpConfigRow = {
  dhcpMode: 'PROXY',
  dhcpLeaseTtlSeconds: 600,
  ipxeBuildTarget: 'IPXE',
  dhcpOptions: [{ code: 66, value: '10.0.0.1' }],
  dhcpProxyAllowedMacs: [MAC],
  dhcpProxyPeerAuthoritative: false,
  dhcpRelayAgentIp: null,
};

describe('toDhcpConfig', () => {
  it('maps a row and treats a non-array options column as empty', () => {
    expect(toDhcpConfig({ ...ROW, dhcpOptions: null })).toEqual({ ...ROW, dhcpOptions: [] });
  });

  it('fails closed on options the schema rejects', () => {
    const options = Array.from({ length: 33 }, (_, i) => ({ code: 100 + i, value: 'x' }));
    expect(() => toDhcpConfig({ ...ROW, dhcpOptions: options })).toThrow(/Malformed dhcpOptions/);
  });
});

describe('readDhcpConfig', () => {
  it('returns null when no prefix row matches', async () => {
    const { client } = fakeClient([[]]);
    await expect(readDhcpConfig(client, { prefixId: PREFIX })).resolves.toBeNull();
  });

  it('maps the row and binds the prefix id', async () => {
    const { client, queries } = fakeClient([[ROW]]);
    await expect(readDhcpConfig(client, { prefixId: PREFIX })).resolves.toEqual(ROW);
    expect(queries[0].values).toContain(PREFIX);
    expect(queries[0].sql).not.toContain('organizationId');
  });

  it('fences the read on the organization when one is given', async () => {
    const { client, queries } = fakeClient([[ROW]]);
    await readDhcpConfig(client, { prefixId: PREFIX, organizationId: ORG });
    expect(queries[0].sql).toContain('AND p."organizationId" = ?');
    expect(queries[0].values).toContain(ORG);
  });
});

describe('readProxyAllowlist', () => {
  it('unions the operator column with reservation macs inside the prefix', async () => {
    const { client, queries } = fakeClient([
      [{ operator: ['80:61:5F:2C:59:AC'], reserved: ['80:61:5f:15:4a:29', '80:61:5f:2c:59:ac'] }],
    ]);
    await expect(readProxyAllowlist(client, { prefixId: PREFIX, organizationId: ORG })).resolves.toEqual([
      '80:61:5f:15:4a:29',
      '80:61:5f:2c:59:ac',
    ]);
    const sql = queries[0].sql;
    expect(sql).toContain('ip.address <<= p.prefix');
    expect(sql).toContain('family(ip.address) = 4');
    expect(count(sql, 'AND p."organizationId" = ')).toBe(1);
  });

  it('returns an empty list when the prefix row is missing', async () => {
    const { client } = fakeClient([[]]);
    await expect(readProxyAllowlist(client, { prefixId: PREFIX })).resolves.toEqual([]);
  });
});

describe('resolveBootIdentity', () => {
  it('returns the resolved devices', async () => {
    const { client, queries } = fakeClient([[{ pxeDeviceId: 'device-1', bmcDeviceId: 'device-2' }]]);
    await expect(resolveBootIdentity(client, { mac: MAC, bmcAddress: BMC })).resolves.toEqual({
      pxeDeviceId: 'device-1',
      bmcDeviceId: 'device-2',
    });
    expect(queries[0].values).toEqual(expect.arrayContaining([MAC, BMC]));
  });

  it('answers two unknowns when the query yields no row', async () => {
    const { client } = fakeClient([[]]);
    await expect(resolveBootIdentity(client, { mac: MAC, bmcAddress: BMC })).resolves.toEqual({
      pxeDeviceId: null,
      bmcDeviceId: null,
    });
  });

  it('reads hub-wide when no organization is given', async () => {
    const { client, queries } = fakeClient([[]]);
    await resolveBootIdentity(client, { mac: MAC, bmcAddress: BMC });
    expect(queries[0].sql).not.toContain('supplierId');
    expect(queries[0].sql).not.toContain('organizationId');
  });

  it('fences both device subqueries and the address on the organization when one is given', async () => {
    const { client, queries } = fakeClient([[]]);
    await resolveBootIdentity(client, { mac: MAC, bmcAddress: BMC, organizationId: ORG });
    expect(count(queries[0].sql, 'AND d."supplierId" = ?')).toBe(2);
    expect(count(queries[0].sql, 'AND ip."organizationId" = ?')).toBe(1);
    expect(queries[0].values.filter((v) => v === ORG)).toHaveLength(3);
  });
});

describe('findBootPrefixForDevice', () => {
  it('prefers the prefix containing the data address', async () => {
    const { client, queries } = fakeClient([[{ id: PREFIX }]]);
    await expect(findBootPrefixForDevice(client, { deviceId: DEVICE, zoneId: ZONE })).resolves.toEqual({
      id: PREFIX,
      selection: 'containing',
    });
    expect(queries).toHaveLength(1);
    expect(queries[0].values).toEqual(expect.arrayContaining([DEVICE, ZONE]));
  });

  it('falls back to the zone primary prefix', async () => {
    const { client, queries } = fakeClient([[], [{ id: PREFIX }]]);
    await expect(findBootPrefixForDevice(client, { deviceId: DEVICE, zoneId: ZONE })).resolves.toEqual({
      id: PREFIX,
      selection: 'primary',
    });
    expect(queries).toHaveLength(2);
    expect(queries[1].sql).toContain(`'PRIMARY'::"IpamRole"`);
    expect(queries[1].values).toContain(ZONE);
  });

  it('returns null when the zone has neither', async () => {
    const { client } = fakeClient([[], []]);
    await expect(findBootPrefixForDevice(client, { deviceId: DEVICE, zoneId: ZONE })).resolves.toBeNull();
  });

  it('fences both lookups on the organization when one is given', async () => {
    const { client, queries } = fakeClient([[], []]);
    await findBootPrefixForDevice(client, { deviceId: DEVICE, zoneId: ZONE, organizationId: ORG });
    for (const query of queries) {
      expect(query.sql).toContain('AND p."organizationId" = ?');
      expect(query.values).toContain(ORG);
    }
  });

  it('reads hub-wide when no organization is given', async () => {
    const { client, queries } = fakeClient([[], []]);
    await findBootPrefixForDevice(client, { deviceId: DEVICE, zoneId: ZONE });
    for (const query of queries) expect(query.sql).not.toContain('organizationId');
  });
});
