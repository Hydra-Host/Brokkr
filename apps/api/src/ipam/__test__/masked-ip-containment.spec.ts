import type { ContextService } from 'src/common/context/context.service';
import type { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpAddressRepository } from '../ip-address/ip-address.repository';
import { PrefixRepository } from '../prefix/prefix.repository';

const PREFIX_ROW = {
  id: 'prefix-1',
  prefix: '10.0.1.0/24',
  status: 'ACTIVE',
  isPool: false,
  role: null,
  zoneId: null,
  organizationId: 'org-1',
  vrfId: null,
  parentId: null,
  vlanId: null,
  gatewayIpId: null,
  vrrpVipId: null,
  prefixRoleId: null,
  enableVlanTag: false,
  bondParameters: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  deletedAt: null,
};

const UTILIZATION_ROW = {
  prefixId: 'prefix-1',
  prefix: '10.0.1.0/24',
  family: 4,
  isPool: false,
  poolCapacity: BigInt(254),
  assignedIps: BigInt(3),
};

const GATEWAY_IP_ROW = { id: 'ip-1', vrfId: null, address: '10.0.1.1/24' };

type SqlLike = { strings: readonly string[]; values: readonly unknown[] };

const isSqlLike = (value: unknown): value is SqlLike =>
  typeof value === 'object' && value !== null && 'strings' in value && 'values' in value;

const flattenSql = (strings: readonly string[], values: readonly unknown[]): string =>
  strings.reduce((acc, part, index) => {
    const value = values[index - 1];
    const rendered = isSqlLike(value) ? flattenSql(value.strings, value.values) : '?';
    return `${acc}${rendered}${part}`;
  });

describe('masked ip containment queries', () => {
  let captured: Array<{ sql: string; values: unknown[] }>;
  let prefixRepo: PrefixRepository;
  let ipRepo: IpAddressRepository;

  beforeEach(() => {
    captured = [];

    const routeRows = (sql: string): unknown[] => {
      if (sql.includes('AS "poolCapacity"')) return [UTILIZATION_ROW];
      if (sql.includes('AS contained')) return [{ contained: true }];
      if (sql.includes('SELECT network(')) return [{ normalized: '10.0.1.0/24' }];
      if (sql.includes('FROM "IpAddress" ip') && sql.includes('WHERE ip.id = ?')) return [GATEWAY_IP_ROW];
      if (sql.includes('FROM "Prefix" p') && sql.includes('WHERE p.id = ?') && sql.includes('LIMIT 1')) {
        return [PREFIX_ROW];
      }
      return [];
    };

    const queryRaw = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = flattenSql(strings, values);
      captured.push({ sql, values });
      return Promise.resolve(routeRows(sql));
    });

    const prisma = { $queryRaw: queryRaw } as unknown as PrismaClient;
    const contextService = { organizationId: 'org-1' } as unknown as ContextService;

    prefixRepo = new PrefixRepository(prisma, contextService);
    ipRepo = new IpAddressRepository(prisma, contextService);
  });

  it('listIpsInPrefix matches ip rows stored with the subnet mask', async () => {
    await prefixRepo.listIpsInPrefix('prefix-1');

    const query = captured.find((c) => c.sql.includes('FROM "IpAddress" ip') && c.sql.includes('ORDER BY ip.address'));
    expect(query?.sql).toContain('ip.address <<= ?::cidr');
  });

  it('getPrefixUtilization counts ip rows stored with the subnet mask', async () => {
    const result = await prefixRepo.getPrefixUtilization('prefix-1');

    const query = captured.find((c) => c.sql.includes('AS "assignedIps"'));
    expect(query?.sql).toContain('ip.address <<= p.prefix');
    expect(result.assignedIps).toBe(3);
  });

  it('listIpAddresses prefix filter matches ip rows stored with the subnet mask', async () => {
    await ipRepo.listIpAddresses({ prefix: '10.0.1.0/24' });

    const query = captured.find((c) => c.sql.includes('FROM "IpAddress" ip') && c.sql.includes('ip.address <<='));
    expect(query?.sql).toContain('ip.address <<= ?::cidr');
  });

  it('accepts a gateway ip stored with the subnet mask', async () => {
    const result = await prefixRepo.validatePrefixGatewayRequest({ prefixId: 'prefix-1', gatewayIpId: 'ip-1' });

    expect(result).toEqual({ valid: true, reason: null });
    const probe = captured.find((c) => c.sql.includes('AS contained'));
    expect(probe?.sql).toContain('?::inet <<= ?::cidr');
    expect(probe?.values).toEqual(['10.0.1.1/24', '10.0.1.0/24']);
  });

  it('keeps strict containment for the child-prefix hierarchy', async () => {
    await prefixRepo.listChildPrefixes('prefix-1');

    const query = captured.find((c) => c.sql.includes('ORDER BY masklen'));
    expect(query?.sql).toContain('p.prefix << ?::cidr');
    expect(query?.sql).not.toContain('p.prefix <<= ?::cidr');
  });
});
