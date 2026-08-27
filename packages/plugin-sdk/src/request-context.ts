import type { OrganizationMembershipRole } from './shared-types';

export const PLUGIN_REQUEST_CONTEXT = Symbol.for('@hydrahost/plugin-sdk/PLUGIN_REQUEST_CONTEXT');

export type PluginAuthType = 'session' | 'api-key';

/** Policy for `requireOperator`. Omit or pass an empty `adminOrganizationId` to accept only instance operators. */
export type PluginOperatorPolicy = {
  adminOrganizationId?: string;
};

export interface PluginRequestContext {
  readonly userId: string;

  readonly email: string;

  readonly firstName: string;

  readonly lastName: string;

  readonly organizationId: string;

  readonly role: OrganizationMembershipRole;

  readonly isInstanceOperator: boolean;

  readonly authType: PluginAuthType;

  requirePermission(resource: string, action: string): void;

  requireInstanceOperator(): void;

  /** Instance operator always; matching non-empty adminOrganizationId also; empty admin org does not grant. */
  requireOperator(policy?: PluginOperatorPolicy): void;

  requireSessionAuth(): void;
}
