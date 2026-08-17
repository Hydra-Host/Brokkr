import { OrganizationMembershipRoleSchema } from '@repo/api-client';
import { EXPIRATION_OPTIONS, VALID_POWER_ACTIONS, VALID_RESCUE_ACTIONS } from '../core/constants.js';

const sortPairs = (fields: readonly string[]): string[] => fields.flatMap((f) => [`${f}:asc`, `${f}:desc`]);

const DEVICE_SORT_FIELDS = [
  'name',
  'nickname',
  'status',
  'gpuModel',
  'gpuCount',
  'memory',
  'isListed',
  'hourlyPrice',
  'ipv4',
  'createdAt',
] as const;

const DEVICE_FILTER_HINTS = [
  'role:eq:Baremetal',
  'role:eq:Decommissioned',
  'role:eq:DiscoveredHost',
  'role:eq:OffMarketplaceHost',
  'role:eq:',
  'status:eq:',
  'gpuModel:contains:',
  'gpuCount:gte:',
  'gpuCount:gte:4',
  'gpuCount:gte:8',
  'memory:gte:',
  'name:contains:',
  'nickname:contains:',
  'createdAt:gt:',
];

const BRIDGE_FILTER_HINTS = [
  'type:eq:managed',
  'type:eq:self-hosted',
  'type:eq:',
  'status:eq:',
  'datacenterName:contains:',
  'zoneName:contains:',
];

const INVENTORY_FILTER_HINTS = [
  'category:eq:b200',
  'category:eq:h100',
  'category:eq:h200',
  'category:eq:',
  'status:eq:on demand',
  'status:eq:reserve',
  'status:eq:preorder',
  'status:eq:',
  'interruptibleReady:eq:true',
  'interruptibleReady:eq:false',
];

export const VALUE_HINTS: Record<string, Record<string, readonly string[]>> = {
  'deployments:power': {
    '--action': VALID_POWER_ACTIONS,
  },
  'deployments:rescue': {
    '--action': VALID_RESCUE_ACTIONS,
  },
  'dcim bridges': {
    '--sort': sortPairs(['name', 'status', 'type', 'datacenterName', 'zoneName']),
    '--filters': BRIDGE_FILTER_HINTS,
  },
  'dcim datacenters': {
    '--sort': sortPairs(['name', 'createdAt']),
  },
  'dcim decommissioned-servers': {
    '--sort': sortPairs(DEVICE_SORT_FIELDS),
    '--filters': DEVICE_FILTER_HINTS,
  },
  'dcim servers': {
    '--sort': sortPairs(DEVICE_SORT_FIELDS),
    '--filters': DEVICE_FILTER_HINTS,
  },
  inventory: {
    '--filters': INVENTORY_FILTER_HINTS,
  },
  'org api-keys': {
    '--sort': sortPairs(['name', 'createdAt', 'expiresAt']),
  },
  'org create-api-key': {
    '--expires-in': EXPIRATION_OPTIONS.map((o) => o.value),
  },
  'org invitations': {
    '--sort': sortPairs(['email', 'role', 'status', 'createdAt', 'expiresAt']),
  },
  'org members': {
    '--role': OrganizationMembershipRoleSchema.options,
    '--sort': sortPairs(['role', 'name', 'email', 'createdAt']),
  },
  'org update-member-role': {
    '--role': OrganizationMembershipRoleSchema.options,
  },
};

export function getValueHints(commandPath: string, flag: string): readonly string[] | undefined {
  return VALUE_HINTS[commandPath]?.[flag];
}
