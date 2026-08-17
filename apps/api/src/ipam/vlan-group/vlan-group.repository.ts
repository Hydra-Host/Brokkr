import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateVlanGroupRequest, VLAN_VID_MAX, VLAN_VID_MIN } from '@repo/api-client';
import { PrismaClient } from 'src/prisma/prisma.client';

export interface UpdateVlanGroupInput {
  name?: string;
  description?: string | null;
  minVid?: number;
  maxVid?: number;
  zoneId?: string | null;
}

function customerReadWhere(organizationId: string) {
  return {
    OR: [{ zone: { organizationId } }, { zoneId: null }],
  };
}

@Injectable()
export class VlanGroupRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(query: { zoneId?: string }, organizationId: string | null) {
    if (organizationId === null) {
      return this.prisma.vlanGroup.findMany({
        where: query.zoneId ? { zoneId: query.zoneId } : undefined,
        orderBy: { name: 'asc' },
      });
    }

    return this.prisma.vlanGroup.findMany({
      where: {
        ...customerReadWhere(organizationId),
        ...(query.zoneId ? { zoneId: query.zoneId } : {}),
      },
      orderBy: { name: 'asc' },
    });
  }

  async findById(id: string, organizationId: string | null) {
    if (organizationId === null) {
      const group = await this.prisma.vlanGroup.findUnique({ where: { id } });
      if (!group) {
        throw new NotFoundException('VLAN group not found');
      }
      return group;
    }

    const group = await this.prisma.vlanGroup.findUnique({
      where: { id, ...customerReadWhere(organizationId) },
    });
    if (!group) {
      throw new NotFoundException('VLAN group not found');
    }
    return group;
  }

  async create(input: CreateVlanGroupRequest, organizationId: string | null) {
    if (organizationId !== null) {
      // Zoneless creates deliberately rejected: customers must not manufacture global VlanGroups.
      if (!input.zoneId) {
        throw new BadRequestException('zoneId is required');
      }
      await this.assertZoneOwnership(input.zoneId, organizationId);
    }

    this.validateVidRange(input.minVid ?? VLAN_VID_MIN, input.maxVid ?? VLAN_VID_MAX);

    const created = await this.prisma.vlanGroup.create({
      data: {
        name: input.name,
        description: input.description ?? undefined,
        minVid: input.minVid,
        maxVid: input.maxVid,
        zoneId: input.zoneId ?? undefined,
      },
    });
    return created;
  }

  async update(id: string, input: UpdateVlanGroupInput, organizationId: string | null) {
    const existing = await this.prisma.vlanGroup.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('VLAN group not found');
    }

    if (organizationId !== null) {
      if (existing.zoneId === null) {
        throw new NotFoundException('VLAN group not found');
      }
      await this.assertZoneOwnership(existing.zoneId, organizationId);
    }

    // After tenancy checks (denied write stays 404/403, not 400); validate the merged pair — a one-sided update must still satisfy the DB range check against the unchanged bound.
    if (input.minVid !== undefined || input.maxVid !== undefined) {
      this.validateVidRange(input.minVid ?? existing.minVid, input.maxVid ?? existing.maxVid);
    }

    const updated = await this.prisma.vlanGroup.update({ where: { id }, data: input });
    return updated;
  }

  async delete(id: string, organizationId: string | null) {
    const existing = await this.prisma.vlanGroup.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('VLAN group not found');
    }

    if (organizationId !== null) {
      if (existing.zoneId === null) {
        throw new NotFoundException('VLAN group not found');
      }
      await this.assertZoneOwnership(existing.zoneId, organizationId);
    }

    await this.prisma.vlanGroup.delete({ where: { id } });
  }

  private validateVidRange(minVid: number, maxVid: number): void {
    if (minVid < VLAN_VID_MIN || minVid > VLAN_VID_MAX) {
      throw new BadRequestException(`minVid must be between ${VLAN_VID_MIN} and ${VLAN_VID_MAX} (got ${minVid})`);
    }
    if (maxVid < VLAN_VID_MIN || maxVid > VLAN_VID_MAX) {
      throw new BadRequestException(`maxVid must be between ${VLAN_VID_MIN} and ${VLAN_VID_MAX} (got ${maxVid})`);
    }
    if (maxVid < minVid) {
      throw new BadRequestException('maxVid must be greater than or equal to minVid');
    }
  }

  private async assertZoneOwnership(zoneId: string, organizationId: string) {
    const zone = await this.prisma.zone.findUnique({
      where: { id: zoneId, organizationId },
      select: { id: true },
    });
    if (!zone) {
      throw new ForbiddenException('Zone does not belong to your organization');
    }
  }
}
