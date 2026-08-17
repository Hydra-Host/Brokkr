import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@repo/database';
import { PrismaClient } from 'src/prisma/prisma.client';

export interface CreateGatewayInput {
  gatewayIpId: string;
  prefixId: string;
  vrfId?: string | null;
  routingPriority?: number | null;
}

export interface UpdateGatewayInput {
  gatewayIpId?: string;
  prefixId?: string;
  vrfId?: string | null;
  routingPriority?: number | null;
}

const gatewayInclude = {
  gatewayIp: { select: { id: true, address: true } },
  vrf: { select: { id: true, name: true } },
} satisfies Prisma.GatewayInclude;

type GatewayRow = Prisma.GatewayGetPayload<{ include: typeof gatewayInclude }>;

interface PrefixSummary {
  id: string;
  prefix: string;
}

@Injectable()
export class GatewayRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(query: { vrfId?: string; prefixId?: string }, organizationId: string | null) {
    const where: Prisma.GatewayWhereInput = {
      ...(query.vrfId ? { vrfId: query.vrfId } : {}),
      ...(query.prefixId ? { prefixId: query.prefixId } : {}),
      ...(organizationId !== null ? { prefix: { organizationId } } : {}),
    };
    const gateways = await this.prisma.gateway.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: gatewayInclude,
    });
    return this.attachPrefixSummaries(gateways);
  }

  async findById(id: string, organizationId: string | null) {
    const gateway = await this.prisma.gateway.findUnique({
      where: {
        id,
        ...(organizationId !== null ? { prefix: { organizationId } } : {}),
      },
      include: gatewayInclude,
    });
    if (!gateway) {
      throw new NotFoundException('Gateway not found');
    }
    return this.attachPrefixSummary(gateway);
  }

  async create(input: CreateGatewayInput, organizationId: string | null) {
    if (organizationId !== null) {
      await this.assertParentOwnership(
        { prefixId: input.prefixId, gatewayIpId: input.gatewayIpId, vrfId: input.vrfId ?? undefined },
        organizationId,
      );
    }

    const created = await this.prisma.gateway.create({
      data: {
        gatewayIpId: input.gatewayIpId,
        prefixId: input.prefixId,
        vrfId: input.vrfId ?? undefined,
        routingPriority: input.routingPriority ?? undefined,
      },
      include: gatewayInclude,
    });
    return this.attachPrefixSummary(created);
  }

  async update(id: string, input: UpdateGatewayInput, organizationId: string | null) {
    const existing = await this.prisma.gateway.findUnique({
      where: {
        id,
        ...(organizationId !== null ? { prefix: { organizationId } } : {}),
      },
    });
    if (!existing) {
      throw new NotFoundException('Gateway not found');
    }

    // New parent FKs must be owned too — else a customer could re-point at another tenant's prefix.
    if (organizationId !== null) {
      const newParents = {
        prefixId: input.prefixId,
        gatewayIpId: input.gatewayIpId,
        vrfId: input.vrfId ?? undefined,
      };
      if (newParents.prefixId || newParents.gatewayIpId || newParents.vrfId) {
        await this.assertParentOwnership(newParents, organizationId);
      }
    }

    const updated = await this.prisma.gateway.update({ where: { id }, data: input, include: gatewayInclude });
    return this.attachPrefixSummary(updated);
  }

  async delete(id: string, organizationId: string | null) {
    const existing = await this.prisma.gateway.findUnique({
      where: {
        id,
        ...(organizationId !== null ? { prefix: { organizationId } } : {}),
      },
    });
    if (!existing) {
      throw new NotFoundException('Gateway not found');
    }
    await this.prisma.gateway.delete({ where: { id } });
  }

  // Prefix.prefix is Unsupported("cidr") — unreachable through a Prisma include, so the CIDR text is joined via raw SQL.
  private async attachPrefixSummaries(rows: GatewayRow[]) {
    if (rows.length === 0) {
      return [];
    }
    const prefixIds = [...new Set(rows.map((row) => row.prefixId))];
    const summaries = await this.prisma.$queryRaw<PrefixSummary[]>`
      SELECT id, prefix::text AS prefix
      FROM "Prefix"
      WHERE id IN (${Prisma.join(prefixIds)})
    `;
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));
    return rows.map((row) => {
      const prefix = byId.get(row.prefixId);
      if (!prefix) {
        throw new NotFoundException('Gateway prefix not found');
      }
      return { ...row, prefix };
    });
  }

  private async attachPrefixSummary(row: GatewayRow) {
    const [withPrefix] = await this.attachPrefixSummaries([row]);
    if (!withPrefix) {
      throw new NotFoundException('Gateway prefix not found');
    }
    return withPrefix;
  }

  // 403 (not 404) on mismatch: the caller knowingly passed an ID they don't own.
  private async assertParentOwnership(
    parents: { prefixId?: string; gatewayIpId?: string; vrfId?: string },
    organizationId: string,
  ) {
    if (parents.prefixId) {
      const prefix = await this.prisma.prefix.findUnique({
        where: { id: parents.prefixId, organizationId },
        select: { id: true },
      });
      if (!prefix) {
        throw new ForbiddenException('Prefix does not belong to your organization');
      }
    }
    if (parents.gatewayIpId) {
      const ip = await this.prisma.ipAddress.findUnique({
        where: { id: parents.gatewayIpId, organizationId },
        select: { id: true },
      });
      if (!ip) {
        throw new ForbiddenException('Gateway IP does not belong to your organization');
      }
    }
    if (parents.vrfId) {
      const vrf = await this.prisma.vrf.findUnique({
        where: { id: parents.vrfId, organizationId },
        select: { id: true },
      });
      if (!vrf) {
        throw new ForbiddenException('VRF does not belong to your organization');
      }
    }
  }
}
