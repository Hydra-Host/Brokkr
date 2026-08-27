import { CanActivate, Inject, Injectable, Optional } from '@nestjs/common';

import { PLUGIN_REQUEST_CONTEXT, type PluginRequestContext } from './request-context';

/** Optional plugin-config org id accepted in addition to instance operators. Empty/absent is fail-closed for that grant. */
export const PLUGIN_OPERATOR_ADMIN_ORG = Symbol.for('@hydrahost/plugin-sdk/PLUGIN_OPERATOR_ADMIN_ORG');

/** Module provider required: an unresolvable controller-scoped guard is silently skipped (bypass). */
@Injectable()
export class PluginOperatorGuard implements CanActivate {
  constructor(
    @Inject(PLUGIN_REQUEST_CONTEXT) private readonly ctx: PluginRequestContext,
    @Optional() @Inject(PLUGIN_OPERATOR_ADMIN_ORG) private readonly adminOrganizationId?: string,
  ) {}

  canActivate(): boolean {
    this.ctx.requireOperator({ adminOrganizationId: this.adminOrganizationId ?? '' });
    return true;
  }
}
