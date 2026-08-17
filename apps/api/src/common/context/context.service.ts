import {
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { OrganizationMembershipRole, RequestSource, TenantType } from '@repo/database';
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import { AuthType, IdentityContext } from 'src/auth/identity-context';
import { OPERATOR_POLICY, type OperatorPolicy } from 'src/common/authz/operator-policy';
import type { DeviceIdentityContext } from 'src/device-tokens/device-tokens.types';

export interface SessionUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

export interface PermissionIntent {
  id: PermissionIntentHandle;
  resource: string;
  action: string;
  denied: boolean;
  finalized: boolean;
}

/** Opaque handle a tier 1 emit names to supersede the intent its gate recorded. */
export type PermissionIntentHandle = string;

export interface ActorFields {
  actorType: RequestSource;
  actorId: string | null;
  actorLabel: string | null;
  apiKeyId: string | null;
  apiKeyLabel: string | null;
}

export interface RequestFields {
  method: string | null;
  path: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface RequestContext {
  requestId: string;
  identity?: IdentityContext;
  deviceIdentity?: DeviceIdentityContext;
  sessionUser?: SessionUser;
  system?: boolean;
  systemOrganizationId?: string;
  intents?: PermissionIntent[];
  method?: string;
  path?: string;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class ContextService {
  private readonly als = new AsyncLocalStorage<RequestContext>();

  constructor(@Inject(OPERATOR_POLICY) private readonly operatorPolicy: OperatorPolicy) {}

  run(context: RequestContext, callback: () => void) {
    this.als.run(context, callback);
  }

  runAsSystem<T>(organizationId: string, fn: () => T): T {
    const existing = this.als.getStore();
    return this.als.run(
      { requestId: existing?.requestId ?? 'system', system: true, systemOrganizationId: organizationId },
      fn,
    );
  }

  get isSystem(): boolean {
    return this.als.getStore()?.system === true;
  }

  get systemOrganizationId(): string | undefined {
    return this.als.getStore()?.systemOrganizationId;
  }

  get requestId(): string | undefined {
    return this.als.getStore()?.requestId;
  }

  get requireRequestId(): string {
    const requestId = this.als.getStore()?.requestId;
    if (!requestId) {
      throw new Error('Request context is missing - requestId is not available outside of a request');
    }
    return requestId;
  }

  get identity(): IdentityContext | undefined {
    return this.als.getStore()?.identity;
  }

  set identity(identity: IdentityContext) {
    this.als.getStore()!.identity = identity;
  }

  get deviceIdentity(): DeviceIdentityContext | undefined {
    return this.als.getStore()?.deviceIdentity;
  }

  set deviceIdentity(deviceIdentity: DeviceIdentityContext) {
    this.als.getStore()!.deviceIdentity = deviceIdentity;
  }

  get requireDeviceIdentity(): DeviceIdentityContext {
    const deviceIdentity = this.als.getStore()?.deviceIdentity;
    if (!deviceIdentity) {
      throw new UnauthorizedException('Device identity context is missing');
    }
    return deviceIdentity;
  }

  get requireIdentity(): IdentityContext {
    const identity = this.als.getStore()?.identity;
    if (!identity) {
      throw new UnauthorizedException(
        'Identity context is missing (org context is not populated on @SessionOnly routes — read the user via sessionUser)',
      );
    }
    return identity;
  }

  get sessionUser(): SessionUser | undefined {
    return this.als.getStore()?.sessionUser;
  }

  set sessionUser(sessionUser: SessionUser) {
    this.als.getStore()!.sessionUser = sessionUser;
  }

  get requireSessionUser(): SessionUser {
    const sessionUser = this.als.getStore()?.sessionUser;
    if (!sessionUser?.email) {
      throw new UnauthorizedException('Session user context is missing');
    }
    return sessionUser;
  }

  get organization() {
    return this.requireIdentity.organization;
  }

  get organizationId(): string {
    // runAsSystem scopes IPAM/active-record writes to systemOrganizationId without a user identity.
    if (this.isSystem) {
      const orgId = this.systemOrganizationId;
      if (!orgId) {
        throw new InternalServerErrorException('System context is missing organizationId');
      }
      return orgId;
    }
    return this.requireIdentity.organizationId;
  }

  /** Non-throwing: an unauthenticated request still passes through the event-log interceptor. */
  get organizationIdOrUndefined(): string | undefined {
    // Device-first, matching buildAuditPayload: a device request binds deviceIdentity, not identity.
    return this.deviceIdentity?.supplierId ?? this.identity?.organizationId ?? this.systemOrganizationId;
  }

  get email(): string {
    switch (this.requireIdentity.authType) {
      case AuthType.Session:
        return this.requireIdentity.session.user.email;
      case AuthType.ApiKey:
        return this.requireIdentity.user.email;
      default:
        throw new UnauthorizedException('Invalid identity context type');
    }
  }

  get userId(): string {
    switch (this.requireIdentity.authType) {
      case AuthType.Session:
        return this.requireIdentity.session.user.id;
      case AuthType.ApiKey:
        return this.requireIdentity.user.id;
      default:
        throw new UnauthorizedException('Invalid identity context type');
    }
  }

  get user() {
    const identity = this.requireIdentity;
    switch (identity.authType) {
      case AuthType.Session:
        return identity.session.user;
      case AuthType.ApiKey:
        return identity.user;
      default:
        throw new UnauthorizedException('Invalid identity context type');
    }
  }

  /** Session-only routes authenticate a real person but never populate `identity` — the same split resolveActor bridges. */
  get actingUser() {
    return this.identity ? this.user : this.requireSessionUser;
  }

  get role(): OrganizationMembershipRole {
    return this.requireIdentity.role;
  }

  get permissions(): ReadonlySet<string> {
    return this.requireIdentity.permissions;
  }

  hasPermission(resource: string, action: string): boolean {
    // Without a bound context this throws via requireIdentity rather than returning false — fail closed.
    if (this.isSystem) return true;
    return this.permissions.has(`${resource}:${action}`);
  }

  /** Returns the recorded intent so a tier 1 emit can supersede it; existing callers ignore the value. */
  requirePermission(resource: string, action: string): PermissionIntentHandle | undefined {
    const denied = !this.hasPermission(resource, action);
    const handle = this.pushIntent(resource, action, denied);
    if (denied) {
      throw new ForbiddenException('You do not have permission to perform this action');
    }
    return handle;
  }

  pushIntent(resource: string, action: string, denied: boolean): PermissionIntentHandle | undefined {
    const store = this.als.getStore();
    if (!store) return undefined;
    const id = randomUUID();
    (store.intents ??= []).push({ id, resource, action, denied, finalized: false });
    return id;
  }

  finalizeIntents(handles: readonly PermissionIntentHandle[]): void {
    const store = this.als.getStore();
    if (!store?.intents) return;
    const superseded = new Set(handles);
    for (const intent of store.intents) {
      if (superseded.has(intent.id)) intent.finalized = true;
    }
  }

  /** Read before drainIntents: a superseded intent drains to nothing, but its gate still spoke. */
  get hasRecordedIntents(): boolean {
    return (this.als.getStore()?.intents?.length ?? 0) > 0;
  }

  drainIntents(): PermissionIntent[] {
    const store = this.als.getStore();
    if (!store?.intents) return [];
    const pending = store.intents.filter((intent) => !intent.finalized);
    store.intents = [];
    return pending;
  }

  get isInstanceOperator(): boolean {
    return this.operatorPolicy.isInstanceOperator(this.organization);
  }

  requireInstanceOperator(): void {
    if (!this.operatorPolicy.isInstanceOperator(this.organization)) {
      throw new ForbiddenException('This action is restricted to the instance operator');
    }
  }

  requireSupplyOrganization(): void {
    if (this.organization.tenantType !== TenantType.SupplyCustomer) {
      throw new ForbiddenException('This action is restricted to supply organizations');
    }
  }

  get requestSource(): RequestSource {
    if (this.deviceIdentity) {
      return RequestSource.DEVICE;
    }

    const identity = this.requireIdentity;
    return identity.authType === AuthType.ApiKey ? RequestSource.API : RequestSource.UI;
  }

  /** API actors resolve actorId to the owning human, so apiKeyId/apiKeyLabel are what distinguish a key's actions. */
  resolveActor(): ActorFields {
    const deviceIdentity = this.deviceIdentity;
    if (deviceIdentity) {
      return {
        actorType: RequestSource.DEVICE,
        actorId: null,
        actorLabel: deviceIdentity.deviceId,
        apiKeyId: null,
        apiKeyLabel: null,
      };
    }

    const identity = this.identity;
    if (!identity) {
      // @SessionOnly routes authenticate a real person but never populate `identity`, so falling
      // straight to SYSTEM would attribute their actions to the platform.
      const sessionUser = this.sessionUser;
      if (sessionUser) {
        return {
          actorType: RequestSource.UI,
          actorId: sessionUser.id,
          actorLabel: sessionUser.email,
          apiKeyId: null,
          apiKeyLabel: null,
        };
      }
      return { actorType: RequestSource.SYSTEM, actorId: null, actorLabel: null, apiKeyId: null, apiKeyLabel: null };
    }

    if (identity.authType === AuthType.ApiKey) {
      return {
        actorType: RequestSource.API,
        actorId: identity.user.id,
        actorLabel: identity.user.email,
        apiKeyId: identity.apiKey.id,
        apiKeyLabel: identity.apiKey.name ?? null,
      };
    }

    return {
      actorType: RequestSource.UI,
      actorId: identity.session.user.id,
      actorLabel: identity.session.user.email,
      apiKeyId: null,
      apiKeyLabel: null,
    };
  }

  actorFields(): ActorFields {
    return this.resolveActor();
  }

  /** Lets a tier 1 emitter record the same request provenance the tier 2 interceptor reads off the request. */
  requestFields(): RequestFields {
    const store = this.als.getStore();
    return {
      method: store?.method ?? null,
      path: store?.path ?? null,
      ipAddress: store?.ipAddress ?? null,
      userAgent: store?.userAgent ?? null,
    };
  }

  buildAuditPayload(): Record<string, string> {
    const deviceIdentity = this.deviceIdentity;
    if (deviceIdentity) {
      return {
        triggeredBy: `device:${deviceIdentity.deviceId}`,
        triggeredByEmail: 'device',
        organizationId: deviceIdentity.supplierId ?? 'unknown',
      };
    }

    const identity = this.identity;
    const triggeredBy =
      identity?.authType === AuthType.Session ? identity.session.user.id : (identity?.apiKey?.referenceId ?? 'unknown');
    const triggeredByEmail = identity?.authType === AuthType.Session ? identity.session.user.email : 'unknown';
    const organizationId = identity?.organizationId ?? 'unknown';
    return { triggeredBy, triggeredByEmail, organizationId };
  }
}
