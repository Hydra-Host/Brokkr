import { Module } from '@nestjs/common';
import { RbacModule } from '@repo/auth/rbac';
import { OrganizationRolesController } from 'src/organizations/organization-roles.controller';
import { OrganizationRolesService } from 'src/organizations/organization-roles.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { MAIN_APP_PERMISSIONS, MAIN_APP_SYSTEM_ROLES } from './permissions.constants';

@Module({
  imports: [
    RbacModule.forRoot({
      config: {
        permissions: MAIN_APP_PERMISSIONS,
        systemRoles: MAIN_APP_SYSTEM_ROLES,
      },
      prismaClient: { useExisting: PrismaClient },
    }),
  ],
  controllers: [OrganizationRolesController],
  providers: [OrganizationRolesService],
})
export class PermissionsModule {}
