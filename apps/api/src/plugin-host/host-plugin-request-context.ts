import type {
  OrganizationMembershipRole,
  PluginAuthType,
  PluginOperatorPolicy,
  PluginRequestContext,
} from '@hydrahost/plugin-sdk';
import { ForbiddenException, Injectable } from '@nestjs/common';

import { AuthType } from '../auth/identity-context';
import { ContextService } from '../common/context/context.service';

@Injectable()
export class HostPluginRequestContext implements PluginRequestContext {
  constructor(private readonly contextService: ContextService) {}

  get userId(): string {
    return this.contextService.userId;
  }

  get email(): string {
    return this.contextService.email;
  }

  get firstName(): string {
    return this.contextService.user.firstName;
  }

  get lastName(): string {
    return this.contextService.user.lastName;
  }

  get organizationId(): string {
    return this.contextService.organizationId;
  }

  get role(): OrganizationMembershipRole {
    return this.contextService.role;
  }

  get isInstanceOperator(): boolean {
    return this.contextService.isInstanceOperator;
  }

  get authType(): PluginAuthType {
    return this.contextService.requireIdentity.authType === AuthType.ApiKey ? 'api-key' : 'session';
  }

  requirePermission(resource: string, action: string): void {
    this.contextService.requirePermission(resource, action);
  }

  requireInstanceOperator(): void {
    this.contextService.requireInstanceOperator();
  }

  requireOperator(policy?: PluginOperatorPolicy): void {
    if (this.isInstanceOperator) {
      return;
    }
    const adminOrganizationId = policy?.adminOrganizationId ?? '';
    if (adminOrganizationId !== '' && this.organizationId === adminOrganizationId) {
      return;
    }
    throw new ForbiddenException('This action is restricted to the instance operator');
  }

  requireSessionAuth(): void {
    if (this.authType === 'api-key') {
      throw new ForbiddenException(
        'This operation requires a browser session and cannot be performed with an API key.',
      );
    }
  }
}
