import { PLUGIN_EVENT_BUS, type PluginEventBus } from '@hydrahost/plugin-sdk';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateOrganizationRequest, UpdateOrganizationRequest } from '@repo/api-client';
import type { SecondaryStorage } from '@repo/auth';
import { MAIN_APP_PERMISSIONS, RbacResolverService, roleBelongsToCatalog } from '@repo/auth/rbac';
import { OrganizationMembershipRole, TenantType } from '@repo/database';
import { paginateArray, type PaginationQuery } from '@repo/database/pagination';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { DeploymentProjectRecord } from 'src/deployments/deployment-project.record';
import { EventLogService } from 'src/event-log/event-log.service';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { AllowedOrgTypesProvider } from './allowed-org-types.provider';
import { OrganizationMembershipsRepository } from './members/organization-members.repository';
import { OrganizationFilters, OrganizationsRepository } from './organizations.repository';
import { ALLOWED_ORG_TYPES } from './organizations.tokens';

const ORGANIZATION_SETTINGS_FIELDS = ['name', 'logo', 'email', 'country', 'metadata'] as const;

const TENANT_TYPE_BY_REQUEST: Record<CreateOrganizationRequest['type'], TenantType> = {
  DemandCustomer: TenantType.DemandCustomer,
  SupplyCustomer: TenantType.SupplyCustomer,
};

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly organizationsRepository: OrganizationsRepository,
    private readonly membershipsRepository: OrganizationMembershipsRepository,
    @Inject(PLUGIN_EVENT_BUS)
    private readonly eventBus: PluginEventBus,
    private readonly contextService: ContextService,
    @Inject('AUTH_SESSION_CACHE')
    private readonly sessionCache: SecondaryStorage | null,
    @Inject(ALLOWED_ORG_TYPES)
    private readonly allowedOrgTypes: AllowedOrgTypesProvider,
    private readonly rbacResolver: RbacResolverService,
    private readonly prisma: PrismaClient,
    private readonly eventLog: EventLogService,
    @Logger(OrganizationsService.name) private readonly logger: LoggerService,
  ) {}

  async create(dto: CreateOrganizationRequest, userId: string) {
    const requestedType = TENANT_TYPE_BY_REQUEST[dto.type];
    if (!this.allowedOrgTypes.getAllowedOrgTypes().includes(requestedType)) {
      throw new ForbiddenException(`Organizations of type "${dto.type}" cannot be created on this instance.`);
    }

    const organization = await this.organizationsRepository.createOrganization({
      name: dto.name,
      tenantType: requestedType,
    });

    const ownerRoleId = await this.membershipsRepository.requireSystemRoleId(OrganizationMembershipRole.Owner);
    await this.membershipsRepository.create(organization.id, userId, OrganizationMembershipRole.Owner, ownerRoleId);

    this.eventBus.emit('organization.created', {
      id: organization.id,
      name: organization.name,
      tenantType: organization.tenantType,
    });

    await DeploymentProjectRecord.createWithRelations({
      name: 'Default Project',
      isDefault: true,
      organizationId: organization.id,
    });

    return organization;
  }

  getAllowedOrganizationTypes(): { types: TenantType[] } {
    return { types: this.allowedOrgTypes.getAllowedOrgTypes() };
  }

  async listForUser(userId: string, query: PaginationQuery) {
    const memberships = await this.organizationsRepository.listMembershipsForUser(userId);

    const organizations = await Promise.all(
      memberships.map(async (m) => {
        const roleVisible = roleBelongsToCatalog(MAIN_APP_PERMISSIONS, m.assignedRole);
        const permissions = Array.from(await this.rbacResolver.resolveEffectivePermissions(m.assignedRoleId));
        return {
          id: m.organization.id,
          name: m.organization.name,
          tenantType: m.organization.tenantType,
          logo: m.organization.logo,
          role: roleVisible ? m.assignedRole.name : 'Managed role',
          assignedRoleId: roleVisible ? m.assignedRoleId : null,
          permissions,
          isDefaultOrg: m.isDefaultOrg ?? null,
        };
      }),
    );
    return paginateArray(organizations, query, { searchableFields: [] });
  }

  async getById() {
    this.contextService.requirePermission('organization', 'read');
    const organizationId = this.contextService.organizationId;
    const organization = await this.organizationsRepository.findOrganizationById(organizationId);
    if (!organization) {
      throw new NotFoundException('Organization not found');
    }
    return organization;
  }

  async getOrganization(filters: OrganizationFilters) {
    return this.organizationsRepository.findOrganization(filters);
  }

  async update(dto: UpdateOrganizationRequest) {
    const handle = this.contextService.requirePermission('organization', 'update');

    const organizationId = this.contextService.organizationId;
    // Mass-assignment guard: explicit field allowlist, never the raw DTO.
    const { name, logo, email, country, metadata } = dto;
    const updated = await this.prisma.$transaction(async (tx) => {
      // Read inside the transaction, so the label and diff describe the row this update replaces.
      const current = await this.organizationsRepository.findOrganizationById(organizationId, tx);
      if (!current) {
        throw new NotFoundException('Organization not found');
      }
      const changedFields = ORGANIZATION_SETTINGS_FIELDS.filter(
        (field) => dto[field] !== undefined && dto[field] !== current[field],
      );
      const row = await this.organizationsRepository.updateOrganization(
        organizationId,
        { name, logo, email, country, metadata },
        tx,
      );
      await this.eventLog.recordInTransaction(tx, {
        organizationId,
        tier: 'EVIDENCE',
        durability: 'ATOMIC',
        resource: 'organization',
        action: 'updated',
        actionKey: 'organization.settings-updated',
        ...this.contextService.actorFields(),
        ...this.contextService.requestFields(),
        targetId: organizationId,
        // Pre-update name: the row names the organization as it stood when the change was made.
        targetLabel: current.name,
        outcome: 'SUCCEEDED',
        requestId: this.contextService.requestId ?? null,
        // Field names only. These settings carry contact and billing detail, so no value is recorded.
        metadata: { changedFields },
      });
      return row;
    });

    // After the transaction resolves: a rollback leaves the intent pending so tier 2 records the failure.
    if (handle) {
      this.contextService.finalizeIntents([handle]);
    }

    const audit = this.contextService.buildAuditPayload();
    this.logger.log(`Organization ${organizationId} updated | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`);

    return updated;
  }

  async setActiveOrganization(userId: string, organizationId: string) {
    const membership = await this.organizationsRepository.findMembership(userId, organizationId);

    if (!membership) {
      throw new ConflictException('User is not a member of this organization');
    }

    const activeSessions = await this.organizationsRepository.findActiveSessions(userId);

    if (activeSessions.length === 0) {
      throw new HttpException('No active session found', HttpStatus.UNAUTHORIZED);
    }

    await this.organizationsRepository.setActiveOrganizationForAllSessions(userId, organizationId);

    const cache = this.sessionCache;
    if (cache) {
      await Promise.all(
        activeSessions.map((s) =>
          cache.delete(s.token).catch((error) => {
            this.logger.warn(
              `Failed to invalidate cached session for user ${userId} on active-org switch; it may read stale until TTL: ${getErrorMessage(error)}`,
            );
          }),
        ),
      );
    }

    return { success: true, organizationId };
  }

  async getSupplyOrganizations(type: string): Promise<{ id: string; name: string }[]> {
    if (type === 'all') {
      return this.organizationsRepository.findAllActiveOrganizations();
    }

    const supplyOrgs = await this.organizationsRepository.findSupplyOrganizationsWithDeviceCount();

    if (type === 'supplyWithDevices') {
      return supplyOrgs.filter((o) => o.devicesAsSupplier.length > 0).map(({ id, name }) => ({ id, name }));
    }

    return supplyOrgs.map(({ id, name }) => ({ id, name }));
  }
}
