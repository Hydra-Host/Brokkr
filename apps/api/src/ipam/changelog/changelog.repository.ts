import { Injectable } from '@nestjs/common';
import { IpamChangelogEntry, IpamChangelogQuery } from '@repo/api-client';
import { Prisma } from '@repo/database';
import { BaseIpamRepository } from '../shared/base-ipam.repository';
import { ChangelogRow } from '../shared/ipam.types';

type AuditTable = 'Vrf' | 'Prefix' | 'IpAddress' | 'Vlan' | 'IpRange';

const ALL_AUDIT_TABLES: AuditTable[] = ['Vrf', 'Prefix', 'IpAddress', 'Vlan', 'IpRange'];

@Injectable()
export class IpamChangelogRepository extends BaseIpamRepository {
  async listIpamChangelog(query: IpamChangelogQuery, organizationId: string): Promise<IpamChangelogEntry[]> {
    const limit = query.limit ?? 50;
    const tables: AuditTable[] = query.tableName ? [query.tableName] : ALL_AUDIT_TABLES;

    const where: Prisma.ChangelogWhereInput = {
      organizationId,
      tableName: { in: tables },
      ...(query.pk ? { pk: query.pk } : {}),
    };

    const rows = await this.changelogFindMany({
      where,
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row: ChangelogRow) => ({
      id: row.id,
      tableName: row.tableName,
      pk: row.pk,
      before: row.before,
      after: row.after,
      diff: row.diff,
      createdAt: row.createdAt,
    }));
  }
}
