/** Cross-tenant IPAM write surface for plugins; host runs `runAsSystem` — callers must gate access. */
export const PLUGIN_IPAM_PROVISIONING = Symbol.for('@hydrahost/plugin-sdk/PLUGIN_IPAM_PROVISIONING');

export type PluginIpamRole = 'PRIMARY' | 'MANAGEMENT';

export interface PluginCreatePrefixInput {
  /** Owning organization — host scopes the write via `runAsSystem`. */
  organizationId: string;
  /** Brokkr zone UUID to attach the prefix to. */
  zoneId: string;
  /** CIDR network block (e.g. `10.0.0.0/24`). */
  prefix: string;
  /** Coarse IPAM role enum (`PRIMARY` data-plane / `MANAGEMENT` OOB). */
  role: PluginIpamRole;
  /** `IpamPrefixVlanRole` slug (`primary` / `management`) for netplan metrics. */
  prefixRoleSlug: 'primary' | 'management';
}

export interface PluginCreatedPrefix {
  id: string;
  prefix: string;
}

export interface PluginCreateIpAddressInput {
  organizationId: string;
  /** Host address; may include CIDR mask (e.g. `10.0.0.5/24`). */
  address: string;
}

export interface PluginCreatedIpAddress {
  id: string;
  address: string;
}

export interface PluginCreateIpRangeInput {
  organizationId: string;
  prefixId: string;
  start: string;
  end: string;
  purpose?: string;
}

export interface PluginCreatedIpRange {
  id: string;
  start: string;
  end: string;
}

export interface PluginIpamRollbackInput {
  organizationId: string;
  prefixIds: string[];
  ipAddressIds: string[];
  ipRangeIds: string[];
}

export interface PluginSetPrefixGatewayInput {
  organizationId: string;
  prefixId: string;
  gatewayIpId: string;
}

/** Host IPAM write surface used by managed operator plugins (bridge-request approve, etc.). */
export interface PluginIpamProvisioning {
  createPrefix(input: PluginCreatePrefixInput): Promise<PluginCreatedPrefix>;
  createIpAddress(input: PluginCreateIpAddressInput): Promise<PluginCreatedIpAddress>;
  setPrefixGateway(input: PluginSetPrefixGatewayInput): Promise<void>;
  createIpRange(input: PluginCreateIpRangeInput): Promise<PluginCreatedIpRange>;
  /** Soft-delete rows created during a failed multi-step provision (best-effort compensation). */
  rollbackProvisioned(input: PluginIpamRollbackInput): Promise<void>;
}
