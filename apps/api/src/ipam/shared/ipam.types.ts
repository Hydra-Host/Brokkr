import { AssignedObjectType, IpamRole, IpRangeStatus, IpStatus, PrefixStatus, VlanStatus } from '@repo/api-client';
import { Prisma } from '@repo/database';

interface PrefixRow {
  id: string;
  prefix: string;
  status: PrefixStatus;
  isPool: boolean;
  role: IpamRole | null;
  zoneId: string | null;
  organizationId: string;
  vrfId: string | null;
  parentId: string | null;
  vlanId: string | null;
  gatewayIpId: string | null;
  vrrpVipId: string | null;
  prefixRoleId: string | null;
  enableVlanTag: boolean;
  bondParameters: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface IpAddressRow {
  id: string;
  address: string;
  status: IpStatus;
  dnsName: string | null;
  organizationId: string;
  vrfId: string | null;
  assignedObjectType: AssignedObjectType | null;
  assignedObjectId: string | null;
  interfaceId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface PrefixOverlapRow {
  id: string;
  prefix: string;
}

interface VlanRow {
  id: string;
  name: string;
  vid: number;
  description: string | null;
  status: VlanStatus;
  organizationId: string;
  vrfId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface IpRangeRow {
  id: string;
  start: string;
  end: string;
  status: IpRangeStatus;
  purpose: string | null;
  organizationId: string;
  prefixId: string;
  vrfId: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface IpRangeOverlapRow {
  id: string;
  start: string;
  end: string;
}

interface ChangelogRow {
  id: string;
  tableName: string;
  pk: string;
  before: Prisma.JsonValue;
  after: Prisma.JsonValue;
  diff: Prisma.JsonValue;
  createdAt: Date;
}

interface PrefixUtilizationRow {
  prefixId: string;
  prefix: string;
  family: number;
  isPool: boolean;
  poolCapacity: bigint | number;
  assignedIps: bigint | number;
}

export type {
  ChangelogRow,
  IpAddressRow,
  IpRangeOverlapRow,
  IpRangeRow,
  PrefixOverlapRow,
  PrefixRow,
  PrefixUtilizationRow,
  VlanRow,
};
