import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Prisma, TenantType } from '@repo/database';
import { SUPPLY_TENANCY_POLICY, type SupplyTenancyPolicy } from 'src/common/authz/supply-tenancy-policy';
import { PrismaClient } from 'src/prisma/prisma.client';

export type OrganizationSummary = { id: string; name: string };

export type OrganizationFilters = Prisma.OrganizationWhereInput;

@Injectable()
export class OrganizationsRepository {
  constructor(
    private readonly prisma: PrismaClient,
    @Inject(SUPPLY_TENANCY_POLICY) private readonly supplyTenancy: SupplyTenancyPolicy,
  ) {}

  async createOrganization(data: { name: string; tenantType: TenantType }) {
    if (data.tenantType !== TenantType.SupplyCustomer) {
      return this.prisma.organization.create({ data });
    }
    const limit = this.supplyTenancy.maxSupplyTenants();
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('supply_tenant_create'))`;
      const existing = await tx.organization.count({
        where: { deletedAt: null, tenantType: TenantType.SupplyCustomer },
      });
      if (existing >= limit) {
        throw new ForbiddenException('This instance has reached its supply-organization limit.');
      }
      return tx.organization.create({ data });
    });
  }

  updateOrganization(id: string, data: Prisma.OrganizationUpdateInput) {
    return this.prisma.organization.update({
      where: { id },
      data,
    });
  }

  findUserById(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
    });
  }

  listMembershipsForUser(userId: string) {
    return this.prisma.member.findMany({
      where: {
        userId,
        deletedAt: null,
        organization: { deletedAt: null },
      },
      include: {
        organization: true,
        assignedRole: {
          select: {
            id: true,
            name: true,
            slug: true,
            rolePermissions: {
              select: { permission: { select: { resource: true, action: true } } },
            },
          },
        },
      },
    });
  }

  findOrganizationById(organizationId: string) {
    return this.prisma.organization.findUnique({
      where: { id: organizationId },
    });
  }

  findMembership(userId: string, organizationId: string) {
    return this.prisma.member.findFirst({
      where: {
        userId,
        organizationId,
        deletedAt: null,
      },
    });
  }

  findActiveSessions(userId: string) {
    return this.prisma.session.findMany({
      where: {
        userId,
        expiresAt: {
          gt: new Date(),
        },
      },
    });
  }

  setActiveOrganizationForAllSessions(userId: string, organizationId: string) {
    return this.prisma.session.updateMany({
      where: {
        userId,
        expiresAt: {
          gt: new Date(),
        },
      },
      data: { activeOrganizationId: organizationId },
    });
  }

  findOrganization(filters: Prisma.OrganizationWhereInput) {
    return this.prisma.organization.findFirst({ where: filters });
  }

  findAllActiveOrganizations(): Promise<OrganizationSummary[]> {
    return this.prisma.organization.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  }

  findSupplyOrganizationsWithDeviceCount() {
    return this.prisma.organization.findMany({
      where: { deletedAt: null, tenantType: TenantType.SupplyCustomer },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, devicesAsSupplier: { select: { id: true }, take: 1 } },
    });
  }
}
