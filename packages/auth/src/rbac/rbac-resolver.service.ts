import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@repo/database';
import { RBAC_CONFIG } from './constants';
import type { RbacConfig } from './types';
import { normalizePermissionSet, permissionKey } from './types';

export const PRISMA_CLIENT = 'RBAC_PRISMA_CLIENT';

@Injectable()
export class RbacResolverService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(RBAC_CONFIG) private readonly config: RbacConfig,
  ) {}

  async resolveEffectivePermissions(roleId: string): Promise<Set<string>> {
    const rolePermissions = await this.prisma.rolePermission.findMany({
      where: { roleId, role: { archivedAt: null } },
      include: { permission: true },
    });

    return normalizePermissionSet(
      this.config.permissions,
      rolePermissions.map((rp) => permissionKey(rp.permission.resource, rp.permission.action)),
    );
  }
}
