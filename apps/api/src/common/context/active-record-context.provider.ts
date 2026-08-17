import { Injectable } from '@nestjs/common';
import type { ActiveRecordContext } from '@repo/active-record';
import { ContextService } from './context.service';

/** Returning `undefined` fails closed (tenant scoping + permission gate), so headless code must use runAsSystem. */
@Injectable()
export class ActiveRecordContextProvider {
  constructor(private readonly contextService: ContextService) {}

  getContext(): ActiveRecordContext | undefined {
    const identity = this.contextService.identity;
    if (identity) {
      return {
        organizationId: identity.organizationId,
        permissions: identity.permissions,
        onPermissionCheck: this.recordIntent,
      };
    }

    if (this.contextService.isSystem) {
      return {
        organizationId: this.contextService.systemOrganizationId!,
        system: true,
        onPermissionCheck: this.recordIntent,
      };
    }

    return undefined;
  }

  /** active-record keys are a single `resource:action` string; a key without a separator is not a policy action. */
  private readonly recordIntent = (permissionKey: string, denied: boolean): void => {
    const separator = permissionKey.indexOf(':');
    if (separator < 0) return;
    this.contextService.pushIntent(permissionKey.slice(0, separator), permissionKey.slice(separator + 1), denied);
  };
}
