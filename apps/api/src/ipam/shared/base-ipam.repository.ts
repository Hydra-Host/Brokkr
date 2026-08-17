import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { BondParametersSchema, IpAddress, IpamPrefix, IpRange, Vlan, Vrf } from '@repo/api-client';
import { Prisma } from '@repo/database';
import { isRecord } from '@repo/utils';
import { ContextService } from 'src/common/context/context.service';
import { ipv4ToInt } from 'src/common/ip-utils';
import { PrismaClient } from 'src/prisma/prisma.client';
import { IpAddressRow, IpRangeRow, PrefixRow, VlanRow } from './ipam.types';

export interface IpamQueryExecutor {
  queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  createChangelog(args: Prisma.ChangelogCreateArgs): Promise<unknown>;
}

@Injectable()
export class IpamTransactionRepository implements IpamQueryExecutor {
  public readonly queryRaw: <T = unknown>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;
  public readonly executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<number>;

  constructor(private readonly tx: Prisma.TransactionClient) {
    this.queryRaw = <T = unknown>(query: TemplateStringsArray, ...values: unknown[]) =>
      this.tx.$queryRaw<T>(query, ...values);
    this.executeRaw = (query: TemplateStringsArray, ...values: unknown[]) => this.tx.$executeRaw(query, ...values);
  }

  createChangelog(args: Prisma.ChangelogCreateArgs) {
    return this.tx.changelog.create(args);
  }
}

@Injectable()
export abstract class BaseIpamRepository {
  private readonly rdRegex = /^\d+:\d+$/;

  constructor(
    protected readonly prisma: PrismaClient,
    protected readonly contextService: ContextService,
  ) {}

  queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]) {
    return this.prisma.$queryRaw<T>(query, ...values);
  }

  executeRaw(query: TemplateStringsArray, ...values: unknown[]) {
    return this.prisma.$executeRaw(query, ...values);
  }

  transaction<T>(handler: (tx: IpamTransactionRepository) => Promise<T>) {
    return this.prisma.$transaction((tx) => handler(new IpamTransactionRepository(tx)));
  }

  vrfFindMany(args: Prisma.VrfFindManyArgs) {
    return this.prisma.vrf.findMany(args);
  }

  vrfCreate(args: Prisma.VrfCreateArgs) {
    return this.prisma.vrf.create(args);
  }

  vrfUpdate(args: Prisma.VrfUpdateArgs) {
    return this.prisma.vrf.update(args);
  }

  vrfFindFirst(args: Prisma.VrfFindFirstArgs) {
    return this.prisma.vrf.findFirst(args);
  }

  changelogFindMany(args: Prisma.ChangelogFindManyArgs) {
    return this.prisma.changelog.findMany(args);
  }

  createChangelog(args: Prisma.ChangelogCreateArgs) {
    return this.prisma.changelog.create(args);
  }

  protected async lockIpamScope(
    executor: IpamQueryExecutor,
    resource: 'ip-address' | 'prefix' | 'vlan',
    organizationId: string,
    vrfId: string | null,
  ): Promise<void> {
    await executor.executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`ipam:${resource}:${organizationId}:${vrfId ?? 'default'}`}))
    `;
  }

  // Global advisory-lock order (deadlock-free iff every path respects it): lockIpamScope → lockIpamPrefix → lockIpamIp; subsets keep this relative order.

  // Serializes a VRF-changing updatePrefix against a VIP-assign on the same prefix — they lock DIFFERENT scope keys, so without this the assign could validate against a stale VRF and leave ip.vrfId !== prefix.vrfId.
  protected async lockIpamPrefix(executor: IpamQueryExecutor, organizationId: string, prefixId: string): Promise<void> {
    await executor.executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`ipam:prefix-id:${organizationId}:${prefixId}`}))
    `;
  }

  // Serializes VIP-assign vs IP-VRF-change on the same IpAddress (they lock DIFFERENT scope keys). Taken LAST in the global order; keyed on the IP id, not the VRF, so the lock holds across the very VRF change being guarded.
  protected async lockIpamIp(executor: IpamQueryExecutor, organizationId: string, ipId: string): Promise<void> {
    await executor.executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`ipam:ip-vip:${organizationId}:${ipId}`}))
    `;
  }

  protected throwConflictOnConstraintError(error: unknown, message: string): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        throw new ConflictException(message);
      }

      if (error.code === 'P2010' && this.isPostgresConstraintConflict(error.meta)) {
        throw new ConflictException(message);
      }

      // CHECK violation (23514) is bad input, not a conflict — 400 with a neutral message,
      // not the caller's misleading overlap wording.
      if (error.code === 'P2010' && isRecord(error.meta) && error.meta.code === '23514') {
        throw new BadRequestException(
          'This change violates a database constraint on the prefix (for example, a DHCP-enabled prefix requires a zone and a non-NAT role).',
        );
      }
    }

    throw error;
  }

  private isPostgresConstraintConflict(meta: unknown): boolean {
    if (!isRecord(meta)) {
      return false;
    }
    return meta.code === '23505' || meta.code === '23P01';
  }

  protected async requireVrf(id: string): Promise<Vrf> {
    const row = await this.vrfFindFirst({
      where: {
        id,
        organizationId: this.contextService.organizationId,
        deletedAt: null,
      },
    });
    if (!row) {
      throw new NotFoundException('VRF not found');
    }
    return row;
  }

  protected async requireVlan(id: string): Promise<Vlan> {
    const rows = await this.queryRaw<VlanRow[]>`
      SELECT
        v.id,
        v.name,
        v.vid,
        v.description,
        v.status,
        v."organizationId",
        v."vrfId",
        v."createdAt",
        v."updatedAt",
        v."deletedAt"
      FROM "Vlan" v
      WHERE v.id = ${id}
        AND v."organizationId" = ${this.contextService.organizationId}
        AND v."deletedAt" IS NULL
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundException('VLAN not found');
    }
    return this.toVlan(rows[0]);
  }

  protected async requireZone(id: string): Promise<void> {
    const rows = await this.queryRaw<Array<{ id: string }>>`
      SELECT z.id
      FROM "Zone" z
      WHERE z.id = ${id}
        AND z."organizationId" = ${this.contextService.organizationId}
        AND z."deletedAt" IS NULL
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundException('Zone not found');
    }
  }

  // Prefix/VLAN roles are a global catalog (no org/soft-delete scoping), unlike zones/VRFs.
  protected async requirePrefixRole(id: string): Promise<void> {
    const rows = await this.queryRaw<Array<{ id: string }>>`
      SELECT r.id
      FROM "IpamPrefixVlanRole" r
      WHERE r.id = ${id}
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundException('Prefix role not found');
    }
  }

  protected async requirePrefix(id: string): Promise<IpamPrefix> {
    const rows = await this.queryRaw<PrefixRow[]>`
      SELECT
        p.id,
        p.prefix::text AS prefix,
        p.status,
        p."isPool",
        p.role,
        p."zoneId",
        p."organizationId",
        p."vrfId",
        p."parentId",
        p."vlanId",
        p."gatewayIpId",
        p."vrrpVipId",
        p."zoneId",
        p."prefixRoleId",
        p."enableVlanTag",
        p."bondParameters",
        p."createdAt",
        p."updatedAt",
        p."deletedAt"
      FROM "Prefix" p
      WHERE p.id = ${id}
        AND p."organizationId" = ${this.contextService.organizationId}
        AND p."deletedAt" IS NULL
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundException('Prefix not found');
    }
    return this.toPrefix(rows[0]);
  }

  protected async requireIpAddress(id: string): Promise<IpAddress> {
    const rows = await this.queryRaw<IpAddressRow[]>`
      SELECT
        ip.id,
        ip.address::text AS address,
        ip.status,
        ip."dnsName",
        ip."organizationId",
        ip."vrfId",
        ip."assignedObjectType",
        ip."assignedObjectId",
        ip."interfaceId",
        ip."createdAt",
        ip."updatedAt",
        ip."deletedAt"
      FROM "IpAddress" ip
      WHERE ip.id = ${id}
        AND ip."organizationId" = ${this.contextService.organizationId}
        AND ip."deletedAt" IS NULL
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundException('IP address not found');
    }
    return this.toIpAddress(rows[0]);
  }

  protected async requireIpRange(id: string): Promise<IpRange> {
    const rows = await this.queryRaw<IpRangeRow[]>`
      SELECT
        r.id,
        r.start::text AS start,
        r."end"::text AS "end",
        r.status,
        r.purpose,
        r."organizationId",
        r."prefixId",
        r."vrfId",
        r."createdAt",
        r."updatedAt",
        r."deletedAt"
      FROM "IpRange" r
      WHERE r.id = ${id}
        AND r."organizationId" = ${this.contextService.organizationId}
        AND r."deletedAt" IS NULL
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundException('IP range not found');
    }
    return this.toIpRange(rows[0]);
  }

  protected async validatePrefixParent(
    parentId: string | null,
    childPrefix: string,
    vrfId: string | null,
    organizationId: string,
    excludePrefixId?: string,
    executor: IpamQueryExecutor = this,
  ): Promise<void> {
    if (!parentId) {
      return;
    }

    const parentRows = await executor.queryRaw<Array<{ id: string; prefix: string; vrfId: string | null }>>`
      SELECT p.id, p.prefix::text AS prefix, p."vrfId"
      FROM "Prefix" p
      WHERE p.id = ${parentId}
        AND p."organizationId" = ${organizationId}
        AND p."deletedAt" IS NULL
      LIMIT 1
    `;
    if (parentRows.length === 0) {
      throw new NotFoundException('Parent prefix not found');
    }

    if (excludePrefixId && parentId === excludePrefixId) {
      throw new BadRequestException('Prefix cannot be its own parent');
    }

    const parent = parentRows[0];
    if ((parent.vrfId ?? null) !== (vrfId ?? null)) {
      throw new BadRequestException('Parent prefix must be in the same VRF as the child prefix');
    }

    const containmentRows = await executor.queryRaw<Array<{ contained: boolean }>>`
      SELECT (${childPrefix}::cidr << ${parent.prefix}::cidr) AS contained
    `;
    if (containmentRows.length === 0 || !containmentRows[0].contained) {
      throw new BadRequestException('Parent prefix must strictly contain child prefix');
    }
  }

  protected async validatePrefixVlanCompatibility(
    prefixVrfId: string | null,
    vlanId: string | null,
    organizationId: string,
    executor: IpamQueryExecutor = this,
  ): Promise<void> {
    if (!vlanId) {
      return;
    }
    const rows = await executor.queryRaw<Array<{ id: string; vrfId: string | null }>>`
      SELECT v.id, v."vrfId"
      FROM "Vlan" v
      WHERE v.id = ${vlanId}
        AND v."organizationId" = ${organizationId}
        AND v."deletedAt" IS NULL
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundException('VLAN not found');
    }
    const vlan = rows[0];
    if ((vlan.vrfId ?? null) !== (prefixVrfId ?? null)) {
      throw new BadRequestException('VLAN VRF scope must match prefix VRF scope');
    }
  }

  private async assertIpEligibleForPrefix({
    ipId,
    candidatePrefix,
    candidateVrfId,
    label,
    executor,
  }: {
    ipId: string;
    candidatePrefix: string;
    candidateVrfId: string | null;
    label: string;
    executor: IpamQueryExecutor;
  }): Promise<void> {
    const rows = await executor.queryRaw<Array<{ id: string; vrfId: string | null; address: string }>>`
      SELECT ip.id, ip."vrfId", ip.address::text AS address
      FROM "IpAddress" ip
      WHERE ip.id = ${ipId}
        AND ip."organizationId" = ${this.contextService.organizationId}
        AND ip."deletedAt" IS NULL
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundException(`${label} address not found`);
    }
    const ip = rows[0];
    if ((ip.vrfId ?? null) !== (candidateVrfId ?? null)) {
      throw new BadRequestException(`${label} VRF scope must match prefix VRF scope`);
    }
    const containment = await executor.queryRaw<Array<{ contained: boolean }>>`
      SELECT (${ip.address}::inet <<= ${candidatePrefix}::cidr) AS contained
    `;
    if (containment.length === 0 || !containment[0].contained) {
      throw new BadRequestException(`${label} must be within the target prefix`);
    }
  }

  protected async validatePrefixGateway({
    prefixId,
    gatewayIpId,
    candidatePrefix,
    candidateVrfId,
    executor = this,
  }: {
    prefixId: string;
    gatewayIpId: string | null;
    candidatePrefix: string;
    candidateVrfId: string | null;
    executor?: IpamQueryExecutor;
  }): Promise<void> {
    if (!gatewayIpId) {
      return;
    }
    await this.assertIpEligibleForPrefix({
      ipId: gatewayIpId,
      candidatePrefix,
      candidateVrfId,
      label: 'Gateway IP',
      executor,
    });

    const duplicateGateway = await executor.queryRaw<Array<{ id: string }>>`
      SELECT p.id
      FROM "Prefix" p
      WHERE p.id <> ${prefixId}
        AND p."organizationId" = ${this.contextService.organizationId}
        AND p."deletedAt" IS NULL
        AND p."gatewayIpId" = ${gatewayIpId}
      LIMIT 1
    `;
    if (duplicateGateway.length > 0) {
      throw new ConflictException('Gateway IP is already assigned to another prefix');
    }
  }

  // Re-read inside the locked tx — the pre-lock snapshot VRF can be stale after a concurrent VRF-changing update.
  protected async readPrefixVrfAndRole(
    prefixId: string,
    executor: IpamQueryExecutor,
  ): Promise<{ vrfId: string | null; role: string | null }> {
    const rows = await executor.queryRaw<Array<{ vrfId: string | null; role: string | null }>>`
      SELECT p."vrfId", p.role
      FROM "Prefix" p
      WHERE p.id = ${prefixId}
        AND p."organizationId" = ${this.contextService.organizationId}
        AND p."deletedAt" IS NULL
      LIMIT 1
    `;
    if (rows.length === 0) {
      throw new NotFoundException('Prefix not found');
    }
    return { vrfId: rows[0].vrfId ?? null, role: rows[0].role ?? null };
  }

  protected async readPrefixVrrpVipId(prefixId: string, executor: IpamQueryExecutor): Promise<string | null> {
    const rows = await executor.queryRaw<Array<{ vrrpVipId: string | null }>>`
      SELECT p."vrrpVipId"
      FROM "Prefix" p
      WHERE p.id = ${prefixId}
        AND p."organizationId" = ${this.contextService.organizationId}
        AND p."deletedAt" IS NULL
      LIMIT 1
    `;
    return rows[0]?.vrrpVipId ?? null;
  }

  protected async validatePrefixVrrpVip({
    prefixId,
    vrrpVipId,
    candidatePrefix,
    candidateVrfId,
    executor = this,
  }: {
    prefixId: string;
    vrrpVipId: string | null;
    candidatePrefix: string;
    candidateVrfId: string | null;
    executor?: IpamQueryExecutor;
  }): Promise<void> {
    if (!vrrpVipId) {
      return;
    }
    await this.assertIpEligibleForPrefix({
      ipId: vrrpVipId,
      candidatePrefix,
      candidateVrfId,
      label: 'VRRP VIP',
      executor,
    });

    const ipState = await executor.queryRaw<
      Array<{ family: number; interfaceId: string | null; assignedObjectId: string | null }>
    >`
      SELECT family(ip.address) AS family, ip."interfaceId", ip."assignedObjectId"
      FROM "IpAddress" ip
      WHERE ip.id = ${vrrpVipId}
        AND ip."organizationId" = ${this.contextService.organizationId}
        AND ip."deletedAt" IS NULL
      LIMIT 1
    `;
    const state = ipState[0];
    if (state && Number(state.family) !== 4) {
      throw new BadRequestException('VRRP VIP must be an IPv4 address');
    }
    if (state && (state.interfaceId !== null || state.assignedObjectId !== null)) {
      throw new ConflictException('VRRP VIP address is assigned to a device interface; choose an unassigned address');
    }

    const duplicateVip = await executor.queryRaw<Array<{ id: string }>>`
      SELECT p.id
      FROM "Prefix" p
      WHERE p.id <> ${prefixId}
        AND p."organizationId" = ${this.contextService.organizationId}
        AND p."deletedAt" IS NULL
        AND p."vrrpVipId" = ${vrrpVipId}
      LIMIT 1
    `;
    if (duplicateVip.length > 0) {
      throw new ConflictException('VRRP VIP is already assigned to another prefix');
    }
  }

  protected async validateIpRangeScope(prefix: IpamPrefix, vrfId: string | null): Promise<void> {
    if ((prefix.vrfId ?? null) !== (vrfId ?? null)) {
      throw new BadRequestException('IP range VRF scope must match parent prefix VRF scope');
    }
  }

  protected async validateIpRangeBounds(prefix: IpamPrefix, start: string, end: string): Promise<void> {
    const orderRows = await this.queryRaw<Array<{ valid: boolean }>>`
      SELECT (${start}::inet <= ${end}::inet) AS valid
    `;
    if (orderRows.length === 0 || !orderRows[0].valid) {
      throw new BadRequestException('IP range start must be less than or equal to end');
    }

    const containmentRows = await this.queryRaw<Array<{ startContained: boolean; endContained: boolean }>>`
      SELECT
        (${start}::inet <<= ${prefix.prefix}::cidr) AS "startContained",
        (${end}::inet <<= ${prefix.prefix}::cidr) AS "endContained"
    `;
    if (containmentRows.length === 0) {
      throw new BadRequestException('Unable to validate IP range containment');
    }
    if (!containmentRows[0].startContained || !containmentRows[0].endContained) {
      throw new BadRequestException('IP range bounds must both be within the parent prefix');
    }
  }

  protected async normalizeCidr(input: string): Promise<string> {
    try {
      const rows = await this.queryRaw<Array<{ normalized: string }>>`
        SELECT network(${input}::inet)::text AS normalized
      `;
      if (rows.length === 0 || !rows[0].normalized) {
        throw new BadRequestException('Invalid CIDR prefix');
      }
      return rows[0].normalized;
    } catch {
      throw new BadRequestException('Invalid CIDR prefix');
    }
  }

  protected async normalizeInet(input: string): Promise<string> {
    try {
      const rows = await this.queryRaw<Array<{ normalized: string }>>`
        SELECT ${input}::inet::text AS normalized
      `;
      if (rows.length === 0 || !rows[0].normalized) {
        throw new BadRequestException('Invalid IP address');
      }
      return rows[0].normalized;
    } catch {
      throw new BadRequestException('Invalid IP address');
    }
  }

  protected validateRd(rd: string | null | undefined): void {
    if (!rd) {
      return;
    }
    if (!this.rdRegex.test(rd)) {
      throw new BadRequestException('RD must use <number>:<number> format');
    }
  }

  protected toPrefix(row: PrefixRow): IpamPrefix {
    return {
      id: row.id,
      prefix: row.prefix,
      status: row.status,
      isPool: row.isPool,
      role: row.role,
      zoneId: row.zoneId,
      organizationId: row.organizationId,
      vrfId: row.vrfId,
      parentId: row.parentId,
      vlanId: row.vlanId,
      gatewayIpId: row.gatewayIpId,
      vrrpVipId: row.vrrpVipId,
      prefixRoleId: row.prefixRoleId,
      enableVlanTag: row.enableVlanTag,
      // bondParameters is JSONB (external data): validate on read and degrade malformed legacy values
      // to null rather than 500-ing the whole prefix; the write path enforces the shape.
      bondParameters: BondParametersSchema.safeParse(row.bondParameters).data ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    };
  }

  protected toIpAddress(row: IpAddressRow): IpAddress {
    return {
      id: row.id,
      address: row.address,
      status: row.status,
      dnsName: row.dnsName,
      organizationId: row.organizationId,
      vrfId: row.vrfId,
      assignedObjectType: row.assignedObjectType,
      assignedObjectId: row.assignedObjectId,
      interfaceId: row.interfaceId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    };
  }

  protected toVlan(row: VlanRow): Vlan {
    return {
      id: row.id,
      name: row.name,
      vid: row.vid,
      description: row.description,
      status: row.status,
      organizationId: row.organizationId,
      vrfId: row.vrfId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    };
  }

  protected toIpRange(row: IpRangeRow): IpRange {
    return {
      id: row.id,
      start: row.start,
      end: row.end,
      status: row.status,
      purpose: row.purpose,
      organizationId: row.organizationId,
      prefixId: row.prefixId,
      vrfId: row.vrfId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    };
  }

  protected toInt(value: bigint | number): number {
    if (typeof value === 'bigint') {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new InternalServerErrorException('Numeric value exceeds JavaScript safe integer range');
      }
      return Number(value);
    }
    return value;
  }

  protected diffRecords(
    before: Prisma.InputJsonObject | null,
    after: Prisma.InputJsonObject | null,
  ): Prisma.InputJsonObject {
    const keys = new Set<string>([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
    const diff: Record<string, Prisma.InputJsonValue> = {};
    for (const key of keys) {
      const previous = before ? before[key] : undefined;
      const next = after ? after[key] : undefined;
      if (JSON.stringify(previous) !== JSON.stringify(next)) {
        diff[key] = {
          before: previous,
          after: next,
        };
      }
    }
    return diff;
  }

  protected async writeAudit(
    tableName: 'Vrf' | 'Prefix' | 'IpAddress' | 'Vlan' | 'IpRange',
    pk: string,
    before: Prisma.InputJsonObject | null,
    after: Prisma.InputJsonObject | null,
    executor: IpamQueryExecutor = this,
  ): Promise<void> {
    const { actorId, actorType } = this.contextService.resolveActor();
    await executor.createChangelog({
      data: {
        tableName,
        pk,
        before: before ?? Prisma.JsonNull,
        after: after ?? Prisma.JsonNull,
        diff: this.diffRecords(before, after),
        organizationId: this.contextService.identity?.organizationId ?? null,
        actorId,
        actorType,
      },
    });
  }

  protected toJsonObject(input: object): Prisma.InputJsonObject {
    const jsonValue = this.toJsonValue(input);
    if (this.isJsonObject(jsonValue)) {
      return jsonValue;
    }
    return {};
  }

  protected toJsonValue(value: unknown): Prisma.InputJsonValue {
    if (value === null) {
      return null;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (Array.isArray(value)) {
      const items: Prisma.InputJsonValue[] = [];
      for (const item of value) {
        items.push(this.toJsonValue(item));
      }
      return items;
    }
    if (typeof value === 'object') {
      const result: Record<string, Prisma.InputJsonValue> = {};
      for (const [key, entry] of Object.entries(value)) {
        result[key] = this.toJsonValue(entry);
      }
      return result;
    }
    return String(value);
  }

  protected isJsonObject(value: Prisma.InputJsonValue): value is Prisma.InputJsonObject {
    return isRecord(value);
  }

  protected parseIpv4Prefix(prefix: string): { network: number; broadcast: number; mask: number } | null {
    const [ip, maskPart] = prefix.split('/');
    if (!ip || !maskPart) {
      return null;
    }
    const mask = Number(maskPart);
    if (!Number.isInteger(mask) || mask < 0 || mask > 32) {
      return null;
    }
    const ipInt = ipv4ToInt(ip);
    if (ipInt === null) {
      return null;
    }

    const maskBits = mask === 0 ? 0 : (0xffffffff << (32 - mask)) >>> 0;
    const network = (ipInt & maskBits) >>> 0;
    const hostMask = ~maskBits >>> 0;
    const broadcast = (network | hostMask) >>> 0;
    return { network, broadcast, mask };
  }

  protected intToIpv4(value: number): string {
    const octet1 = (value >>> 24) & 255;
    const octet2 = (value >>> 16) & 255;
    const octet3 = (value >>> 8) & 255;
    const octet4 = value & 255;
    return `${octet1}.${octet2}.${octet3}.${octet4}`;
  }
}
