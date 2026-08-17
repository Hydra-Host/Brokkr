import { allocateIpInPrefix, type IpamTxClient } from '../allocator';

function makeTx(opts: {
  prefix?: { prefix: string; status: string; isPool: boolean; vrfId: string | null };
  existing?: string[];
}) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx: IpamTxClient = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $queryRawUnsafe: async (sql: string, ...values: unknown[]): Promise<any> => {
      calls.push({ sql, values });
      if (sql.includes('FROM "Prefix"')) return opts.prefix ? [opts.prefix] : [];
      if (sql.includes('FROM "IpAddress"')) return (opts.existing ?? []).map((address) => ({ address }));
      return [];
    },
    $executeRawUnsafe: async (sql: string, ...values: unknown[]): Promise<number> => {
      calls.push({ sql, values });
      return 1;
    },
  };
  return { tx, calls };
}

describe('allocateIpInPrefix', () => {
  it('locks, computes the first free IP, and inserts it', async () => {
    const { tx, calls } = makeTx({
      prefix: { prefix: '10.0.0.0/29', status: 'ACTIVE', isPool: false, vrfId: 'vrf-1' },
      existing: ['10.0.0.1', '10.0.0.2'],
    });

    const result = await allocateIpInPrefix(tx, { prefixId: 'pfx-1', organizationId: 'org-1' });

    expect(result.address).toBe('10.0.0.3');
    expect(result.vrfId).toBe('vrf-1');

    expect(calls[0].sql).toContain('pg_advisory_xact_lock');
    expect(calls[0].values[0]).toBe('ipam-allocate-ip:pfx-1');

    const insert = calls.find((c) => c.sql.includes('INSERT INTO "IpAddress"'));
    expect(insert).toBeDefined();
    expect(insert?.values.slice(1)).toEqual(['10.0.0.3', 'ACTIVE', null, 'org-1', 'vrf-1', null, null]);
  });

  it('threads status, interface and NAT inside id into the insert', async () => {
    const { tx, calls } = makeTx({
      prefix: { prefix: '172.16.0.0/24', status: 'ACTIVE', isPool: false, vrfId: null },
      existing: [],
    });

    await allocateIpInPrefix(tx, {
      prefixId: 'pfx-2',
      organizationId: 'org-2',
      status: 'RESERVED',
      interfaceId: 'if-9',
      natInsideId: 'ip-inside',
    });

    const insert = calls.find((c) => c.sql.includes('INSERT INTO "IpAddress"'));
    expect(insert?.values.slice(1)).toEqual(['172.16.0.1', 'RESERVED', null, 'org-2', null, 'if-9', 'ip-inside']);
  });

  it('treats addresses stored with the subnet mask as used', async () => {
    const { tx, calls } = makeTx({
      prefix: { prefix: '10.0.0.0/29', status: 'ACTIVE', isPool: false, vrfId: null },
      existing: ['10.0.0.1/29', '10.0.0.2/29'],
    });

    const result = await allocateIpInPrefix(tx, { prefixId: 'pfx-6', organizationId: 'org-1' });

    expect(result.address).toBe('10.0.0.3');
    const usedQuery = calls.find((c) => c.sql.includes('FROM "IpAddress"'));
    expect(usedQuery?.sql).toContain('address <<= $1::cidr');
  });

  it('rejects a container prefix', async () => {
    const { tx } = makeTx({ prefix: { prefix: '10.0.0.0/8', status: 'CONTAINER', isPool: false, vrfId: null } });
    await expect(allocateIpInPrefix(tx, { prefixId: 'pfx-3', organizationId: 'org-1' })).rejects.toThrow('CONTAINER');
  });

  it('throws when the prefix is missing', async () => {
    const { tx } = makeTx({});
    await expect(allocateIpInPrefix(tx, { prefixId: 'nope', organizationId: 'org-1' })).rejects.toThrow('not found');
  });

  it('throws when the prefix is exhausted', async () => {
    const { tx } = makeTx({
      prefix: { prefix: '10.0.0.0/30', status: 'ACTIVE', isPool: false, vrfId: null },
      existing: ['10.0.0.1', '10.0.0.2'],
    });
    await expect(allocateIpInPrefix(tx, { prefixId: 'pfx-4', organizationId: 'org-1' })).rejects.toThrow(
      'no available addresses',
    );
  });
});
