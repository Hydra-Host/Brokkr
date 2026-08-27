import { ForbiddenException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiKeyWithCreator, CreatedApiKey } from '@repo/api-client';
import {
  AuthClient,
  isGrantableApiKeyPermission as isDelegableApiKeyPermission,
  parseApiKeyPermissionScope,
  permissionKeysToRecord,
} from '@repo/auth';
import {
  MAIN_APP_PERMISSIONS,
  normalizePermissionSet,
  RbacResolverService,
  roleBelongsToCatalog,
  type RolePermissionSource,
} from '@repo/auth/rbac';
import { PaginatedResult, paginateQuery, PaginationQuery } from '@repo/database/pagination';
import { ContextService, type PermissionIntentHandle } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { EventLogService } from 'src/event-log/event-log.service';
import type { EventLogMetadata, EventLogWrite } from 'src/event-log/event-log.types';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { apiKeysPaginationConfig } from './organization-api-keys.pagination';

const API_KEY_CREATED = { resource: 'api-key', action: 'created', actionKey: 'api-key.created' };
const API_KEY_SCOPE_CHANGED = { resource: 'api-key', action: 'scope-changed', actionKey: 'api-key.scope-changed' };
const API_KEY_REVOKED = { resource: 'api-key', action: 'revoked', actionKey: 'api-key.revoked' };

interface ApiKeyEvent {
  resource: string;
  action: string;
  actionKey: string;
  targetId: string;
  targetLabel: string | null;
  metadata?: EventLogMetadata;
}

function displayRole(role: ({ name: string } & RolePermissionSource) | null | undefined): string {
  if (!role) return 'Member';
  return roleBelongsToCatalog(MAIN_APP_PERMISSIONS, role) ? role.name : 'Managed role';
}

function publicApiKeyPermissions(value: string | null): string[] | null {
  const scope = parseApiKeyPermissionScope(value);
  if (scope.kind === 'inherit') return null;
  if (scope.kind === 'malformed') return [];
  return Array.from(normalizePermissionSet(MAIN_APP_PERMISSIONS, scope.permissions));
}

@Injectable()
export class OrganizationApiKeysService {
  constructor(
    private readonly contextService: ContextService,
    private readonly prisma: PrismaClient,
    @Inject('AUTH_CLIENT') private readonly authClient: AuthClient,
    private readonly rbacResolver: RbacResolverService,
    private readonly eventLog: EventLogService,
    @Logger(OrganizationApiKeysService.name) private readonly logger: LoggerService,
  ) {}

  async listApiKeys(query: PaginationQuery): Promise<PaginatedResult<ApiKeyWithCreator>> {
    this.contextService.requirePermission('api-key', 'read');
    const organizationId = this.contextService.organizationId;

    const result = await paginateQuery(this.prisma.apiKey, query, apiKeysPaginationConfig, {
      where: {
        organizationId,
        enabled: true,
      },
      include: {
        user: {
          select: {
            name: true,
            email: true,
            members: {
              where: { organizationId },
              select: {
                assignedRole: {
                  select: {
                    name: true,
                    rolePermissions: {
                      select: { permission: { select: { resource: true, action: true } } },
                    },
                  },
                },
              },
              take: 1,
            },
          },
        },
      },
    });

    const mappedData = result.data.map((key: any) => ({
      id: key.id,
      name: key.name,
      start: key.start,
      prefix: key.prefix,
      userId: key.userId,
      organizationId: key.organizationId,
      role: displayRole(key.user.members[0]?.assignedRole),
      enabled: key.enabled,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
      updatedAt: key.updatedAt,
      requestCount: key.requestCount,
      remaining: key.remaining,
      lastRequest: key.lastRequest,
      metadata: key.metadata,
      permissions: publicApiKeyPermissions(key.permissions),
      createdByName: key.user.name,
      createdByEmail: key.user.email,
    }));

    return {
      data: mappedData,
      meta: result.meta,
    };
  }

  async getApiKey(apiKeyId: string): Promise<ApiKeyWithCreator> {
    this.contextService.requirePermission('api-key', 'read');
    return this.loadApiKeyWithCreator(apiKeyId, { enabledOnly: true });
  }

  private async loadApiKeyWithCreator(apiKeyId: string, opts: { enabledOnly: boolean }): Promise<ApiKeyWithCreator> {
    const organizationId = this.contextService.organizationId;

    const key = await this.prisma.apiKey.findUnique({
      where: {
        id: apiKeyId,
        organizationId,
        ...(opts.enabledOnly ? { enabled: true } : {}),
      },
      include: {
        user: {
          select: {
            name: true,
            email: true,
            members: {
              where: { organizationId },
              select: {
                assignedRole: {
                  select: {
                    name: true,
                    rolePermissions: {
                      select: { permission: { select: { resource: true, action: true } } },
                    },
                  },
                },
              },
              take: 1,
            },
          },
        },
      },
    });

    if (!key) {
      throw new NotFoundException('API key not found');
    }

    return {
      id: key.id,
      name: key.name,
      start: key.start,
      prefix: key.prefix,
      userId: key.userId,
      organizationId: key.organizationId,
      role: displayRole(key.user.members[0]?.assignedRole),
      enabled: key.enabled,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
      updatedAt: key.updatedAt,
      requestCount: key.requestCount,
      remaining: key.remaining,
      lastRequest: key.lastRequest,
      metadata: key.metadata,
      permissions: publicApiKeyPermissions(key.permissions),
      createdByName: key.user.name,
      createdByEmail: key.user.email,
    };
  }

  async createApiKey(
    headers: Record<string, string>,
    data: { name: string; expiresIn?: number; permissions?: string[] },
  ): Promise<CreatedApiKey> {
    const handle = this.contextService.requirePermission('api-key', 'create');

    const organizationId = this.contextService.organizationId;
    const role = this.contextService.role;

    const permissions = data.permissions?.length ? data.permissions : null;
    if (permissions) {
      this.assertPermissionsWithinActor(permissions);
      this.assertDelegablePermissions(permissions);
    }

    const result = await this.authClient.api.createApiKey({
      body: {
        name: data.name,
        expiresIn: data.expiresIn === undefined ? undefined : data.expiresIn / 1000,
        metadata: { organizationId },
        userId: this.contextService.userId,
        ...(permissions ? { permissions: permissionKeysToRecord(permissions) } : {}),
      },
    });

    if (!result) {
      throw new HttpException('Failed to create API key', HttpStatus.BAD_REQUEST);
    }

    try {
      await this.prisma.apiKey.update({
        where: { id: result.id },
        data: { organizationId },
      });
    } catch (error) {
      const rollback = await this.authClient.api
        .deleteApiKey({ body: { keyId: result.id }, headers })
        .catch(() => null);
      if (!rollback?.success) {
        this.logger.error(`Failed to roll back orphaned API key ${result.id} after org-scope update failure`);
      }
      throw error;
    }

    // After the compensating path, so a rolled-back creation records nothing.
    await this.recordPostCommit(handle, {
      ...API_KEY_CREATED,
      targetId: result.id,
      targetLabel: result.name ?? null,
      metadata: this.scopeMetadata(permissions),
    });

    const user = this.contextService.user;

    // Audit key id + name only, NEVER the plaintext key.
    const audit = this.contextService.buildAuditPayload();
    this.logger.log(
      `API key created id=${result.id} name=${result.name ?? '(unnamed)'} org=${organizationId} | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`,
    );

    return {
      id: result.id,
      name: result.name ?? null,
      start: result.start ?? null,
      prefix: result.prefix ?? null,
      key: result.key,
      userId: result.referenceId,
      organizationId,
      role,
      enabled: result.enabled,
      expiresAt: result.expiresAt ? new Date(result.expiresAt) : null,
      createdAt: new Date(result.createdAt),
      updatedAt: new Date(result.updatedAt),
      requestCount: result.requestCount,
      remaining: result.remaining ?? null,
      lastRequest: result.lastRequest ? new Date(result.lastRequest) : null,
      metadata: result.metadata ? JSON.stringify(result.metadata) : null,
      permissions,
      createdByName: user.name,
      createdByEmail: user.email,
    };
  }

  async updateApiKey(apiKeyId: string, permissions: string[] | null): Promise<ApiKeyWithCreator> {
    const organizationId = this.contextService.organizationId;

    const key = await this.prisma.apiKey.findUnique({ where: { id: apiKeyId, organizationId } });
    if (!key) {
      throw new NotFoundException('API key not found');
    }

    const handle = this.assertCanManageKey(key.userId, 'update');
    const requestedPermissions = permissions?.length ? permissions : null;
    if (requestedPermissions) {
      if (key.userId === this.contextService.userId) {
        this.assertPermissionsWithinActor(requestedPermissions);
      }
      this.assertDelegablePermissions(requestedPermissions);
      await this.assertPermissionsWithinOwner(key.userId, organizationId, requestedPermissions);
    }

    const updateResult = await this.authClient.api.updateApiKey({
      body: {
        keyId: apiKeyId,
        userId: key.userId,
        permissions: requestedPermissions ? permissionKeysToRecord(requestedPermissions) : {},
      },
    });

    if (!updateResult) {
      throw new HttpException('Failed to update API key', HttpStatus.BAD_REQUEST);
    }

    await this.recordPostCommit(handle, {
      ...API_KEY_SCOPE_CHANGED,
      targetId: apiKeyId,
      targetLabel: key.name,
      metadata: this.scopeMetadata(requestedPermissions),
    });

    // Skip getApiKey's gates: a disabled key's scope is still editable, and failing here would 403/404 a persisted change.
    return this.loadApiKeyWithCreator(apiKeyId, { enabledOnly: false });
  }

  /** Ownership manages a key without holding the permission, so that branch records its own intent —
   *  otherwise a self-service revoke would leave tier 2 nothing to fall back on. */
  private assertCanManageKey(ownerUserId: string, action: 'update' | 'delete'): PermissionIntentHandle | undefined {
    if (ownerUserId === this.contextService.userId) {
      return this.contextService.pushIntent('api-key', action, false);
    }
    return this.contextService.requirePermission('api-key', action);
  }

  private baseWrite(event: ApiKeyEvent): Omit<EventLogWrite, 'durability' | 'outcome'> {
    return {
      organizationId: this.contextService.organizationId,
      tier: 'EVIDENCE',
      resource: event.resource,
      action: event.action,
      actionKey: event.actionKey,
      ...this.contextService.actorFields(),
      ...this.contextService.requestFields(),
      targetId: event.targetId,
      targetLabel: event.targetLabel,
      requestId: this.contextService.requestId ?? null,
      ...(event.metadata ? { metadata: event.metadata } : {}),
    };
  }

  /** The Better Auth write has already committed, so the handle is finalized only once the row lands: a crash
   *  between the two loses it, and throwing would answer a live key with a 500 instead of letting tier 2 record. */
  private async recordPostCommit(handle: PermissionIntentHandle | undefined, event: ApiKeyEvent): Promise<void> {
    const write: EventLogWrite = { ...this.baseWrite(event), durability: 'POST_COMMIT', outcome: 'SUCCEEDED' };
    try {
      await this.eventLog.record(write);
      this.supersede(handle);
    } catch (error) {
      this.logger.error(
        `Failed to persist event ${write.actionKey} for organization ${write.organizationId}: ${getErrorMessage(error)}`,
      );
    }
  }

  private supersede(handle: PermissionIntentHandle | undefined): void {
    if (handle) this.contextService.finalizeIntents([handle]);
  }

  private scopeMetadata(permissions: string[] | null): EventLogMetadata {
    return permissions ? { scope: 'explicit', grantedKeys: [...permissions].sort() } : { scope: 'inherit' };
  }

  // A key's scope can never exceed the caller's own; reject up front rather than let the guard silently narrow at runtime.
  private assertPermissionsWithinActor(permissions: string[]): void {
    const actorPermissions = this.contextService.permissions;
    const escalated = permissions.filter((permission) => !actorPermissions.has(permission));
    if (escalated.length > 0) {
      throw new ForbiddenException(`Cannot grant permissions you do not hold: ${escalated.join(', ')}`);
    }
  }

  private assertDelegablePermissions(permissions: string[]): void {
    const forbidden = permissions.filter((permission) => !isDelegableApiKeyPermission(permission));
    if (forbidden.length > 0) {
      throw new ForbiddenException(`Cannot delegate API-key lifecycle or owner permissions: ${forbidden.join(', ')}`);
    }
  }

  // Caps a key at its OWNER's live permissions (fails closed: no membership/role resolves to the empty set).
  private async assertPermissionsWithinOwner(
    ownerUserId: string,
    organizationId: string,
    permissions: string[],
  ): Promise<void> {
    const ownerPermissions = await this.resolveOwnerPermissions(ownerUserId, organizationId);
    const beyondOwner = permissions.filter((permission) => !ownerPermissions.has(permission));
    if (beyondOwner.length > 0) {
      throw new ForbiddenException(`Cannot grant permissions the key owner does not hold: ${beyondOwner.join(', ')}`);
    }
  }

  private async resolveOwnerPermissions(ownerUserId: string, organizationId: string): Promise<ReadonlySet<string>> {
    if (ownerUserId === this.contextService.userId) {
      return this.contextService.permissions;
    }
    const ownerMember = await this.prisma.member.findFirst({
      where: { userId: ownerUserId, organizationId, deletedAt: null },
      select: { assignedRoleId: true },
    });
    return ownerMember
      ? await this.rbacResolver.resolveEffectivePermissions(ownerMember.assignedRoleId)
      : new Set<string>();
  }

  async deleteApiKey(apiKeyId: string): Promise<{ success: boolean }> {
    const organizationId = this.contextService.organizationId;

    const key = await this.prisma.apiKey.findUnique({
      where: {
        id: apiKeyId,
        organizationId,
      },
    });

    if (!key) {
      throw new NotFoundException('API key not found');
    }

    const handle = this.assertCanManageKey(key.userId, 'delete');

    await this.prisma.$transaction(async (tx) => {
      await tx.apiKey.delete({ where: { id: apiKeyId } });
      await this.eventLog.recordInTransaction(tx, {
        ...this.baseWrite({ ...API_KEY_REVOKED, targetId: apiKeyId, targetLabel: key.name }),
        durability: 'ATOMIC',
        outcome: 'SUCCEEDED',
      });
    });
    this.supersede(handle);

    const audit = this.contextService.buildAuditPayload();
    this.logger.log(
      `API key deleted id=${apiKeyId} org=${organizationId} | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`,
    );

    return { success: true };
  }
}
