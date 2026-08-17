import { randomUUID } from 'node:crypto';

import { Prefix, PrefixStatus } from './models/prefix';

/** `allocateIpInPrefix` MUST run inside a transaction — the advisory xact-lock only holds for its lifetime. */
export interface IpamTxClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

export type IpStatus = 'ACTIVE' | 'RESERVED' | 'DEPRECATED' | 'DHCP';

export interface AllocateIpParams {
  prefixId: string;
  organizationId: string;
  status?: IpStatus;
  interfaceId?: string | null;
  natInsideId?: string | null;
  dnsName?: string | null;
}

export interface AllocatedIp {
  id: string;
  address: string;
  vrfId: string | null;
}

interface PrefixRow {
  prefix: string;
  status: string;
  isPool: boolean;
  vrfId: string | null;
}

export async function allocateIpInPrefix(tx: IpamTxClient, params: AllocateIpParams): Promise<AllocatedIp> {
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `ipam-allocate-ip:${params.prefixId}`);

  const prefixRows = await tx.$queryRawUnsafe<PrefixRow[]>(
    'SELECT prefix::text AS prefix, status, "isPool" AS "isPool", "vrfId" AS "vrfId" ' +
      'FROM "Prefix" WHERE id = $1 AND "deletedAt" IS NULL',
    params.prefixId,
  );
  const prefixRow = prefixRows[0];
  if (!prefixRow) throw new Error(`Prefix ${params.prefixId} not found`);
  if (prefixRow.status === 'CONTAINER') {
    throw new Error(`Prefix ${params.prefixId} is a CONTAINER and cannot allocate individual IPs`);
  }

  // <<= not <<: rows stored with the subnet's mask (10.0.1.2/24) must count as used or they'd be re-allocated
  const ipRows = await tx.$queryRawUnsafe<{ address: string }[]>(
    'SELECT address::text AS address FROM "IpAddress" ' +
      'WHERE address <<= $1::cidr AND "deletedAt" IS NULL AND "vrfId" IS NOT DISTINCT FROM $2',
    prefixRow.prefix,
    prefixRow.vrfId,
  );

  const prefix = new Prefix({
    id: params.prefixId,
    prefix: prefixRow.prefix,
    status: prefixRow.status === 'CONTAINER' ? PrefixStatus.Container : PrefixStatus.Active,
    vrfId: prefixRow.vrfId ?? undefined,
    isPool: prefixRow.isPool,
  });

  const address = prefix.getFirstAvailableIp(ipRows.map((r) => r.address));
  if (!address) throw new Error(`Prefix ${params.prefixId} (${prefixRow.prefix}) has no available addresses`);

  const id = randomUUID();
  await tx.$executeRawUnsafe(
    'INSERT INTO "IpAddress" ' +
      '(id, address, status, "dnsName", "createdAt", "updatedAt", "organizationId", "vrfId", "interfaceId", "natInsideId") ' +
      'VALUES ($1, $2::inet, $3::"IpStatus", $4, now(), now(), $5, $6, $7, $8)',
    id,
    address,
    params.status ?? 'ACTIVE',
    params.dnsName ?? null,
    params.organizationId,
    prefixRow.vrfId,
    params.interfaceId ?? null,
    params.natInsideId ?? null,
  );

  return { id, address, vrfId: prefixRow.vrfId };
}
