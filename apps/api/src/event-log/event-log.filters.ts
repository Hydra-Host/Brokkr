import type { EventLogFilterQuery } from '@repo/api-client';
import { Prisma, type RequestSource } from '@repo/database';

/** Stored but hidden by default, so the feed reads as human activity rather than machine noise. */
const HIDDEN_ACTOR_TYPES: readonly RequestSource[] = ['DEVICE', 'SYSTEM'];

interface EventLogFilterFields {
  organizationId: string;
  actionKey?: string;
  resource?: string;
  tier?: EventLogFilterQuery['tier'];
  durability?: EventLogFilterQuery['durability'];
  actorId?: string;
  outcome?: EventLogFilterQuery['outcome'];
  targetId?: string;
  from?: Date;
  to?: Date;
}

/** Exclusive by construction. Given both, `toEventLogWhere` would keep only the exclusion while
 *  `toEventLogSqlConditions` would emit both predicates — one filter, two different answers. */
type EventLogActorFilter =
  | { actorType: RequestSource; hiddenActorTypes?: never }
  | { actorType?: never; hiddenActorTypes: readonly RequestSource[] }
  | { actorType?: never; hiddenActorTypes?: never };

/** One normalized description of a filtered slice, compiled to a Prisma `where` for the offset browse
 *  and to SQL for the keyset export, so the two paths cannot answer the same query differently. */
export type EventLogFilter = EventLogFilterFields & EventLogActorFilter;

/** Read side only. This app compiles with `strictNullChecks: false`, under which narrowing one actor
 *  field collapses the other to `never`; widening once keeps both readable without weakening authorship. */
type ReadableEventLogFilter = EventLogFilterFields & {
  actorType?: RequestSource;
  hiddenActorTypes?: readonly RequestSource[];
};

export function toEventLogFilter(organizationId: string, query: EventLogFilterQuery): EventLogFilter {
  return {
    ...toActorFilter(query),
    organizationId,
    ...(query.actionKey ? { actionKey: query.actionKey } : {}),
    ...(query.resource ? { resource: query.resource } : {}),
    ...(query.tier ? { tier: query.tier } : {}),
    ...(query.durability ? { durability: query.durability } : {}),
    ...(query.actorId ? { actorId: query.actorId } : {}),
    ...(query.outcome ? { outcome: query.outcome } : {}),
    ...(query.targetId ? { targetId: query.targetId } : {}),
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
  };
}

function toActorFilter(query: EventLogFilterQuery): EventLogActorFilter {
  if (query.actorType) return { actorType: query.actorType };
  if (query.includeSystemActors) return {};
  return { hiddenActorTypes: HIDDEN_ACTOR_TYPES };
}

export function toEventLogWhere(input: EventLogFilter): Prisma.EventLogWhereInput {
  const filter: ReadableEventLogFilter = input;
  const where: Prisma.EventLogWhereInput = {
    organizationId: filter.organizationId,
    ...(filter.actionKey ? { actionKey: filter.actionKey } : {}),
    ...(filter.resource ? { resource: filter.resource } : {}),
    ...(filter.tier ? { tier: filter.tier } : {}),
    ...(filter.durability ? { durability: filter.durability } : {}),
    ...(filter.actorId ? { actorId: filter.actorId } : {}),
    ...(filter.outcome ? { outcome: filter.outcome } : {}),
    ...(filter.targetId ? { targetId: filter.targetId } : {}),
    ...(filter.actorType ? { actorType: filter.actorType } : {}),
    ...(filter.hiddenActorTypes ? { actorType: { notIn: [...filter.hiddenActorTypes] } } : {}),
  };

  if (filter.from || filter.to) {
    where.createdAt = { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) };
  }

  return where;
}

/** Enum columns need an explicit cast: the driver binds every filter value as text. */
export function toEventLogSqlConditions(input: EventLogFilter): Prisma.Sql[] {
  const filter: ReadableEventLogFilter = input;
  const conditions = [Prisma.sql`"organizationId" = ${filter.organizationId}`];

  if (filter.actionKey) conditions.push(Prisma.sql`"actionKey" = ${filter.actionKey}`);
  if (filter.resource) conditions.push(Prisma.sql`"resource" = ${filter.resource}`);
  if (filter.tier) conditions.push(Prisma.sql`"tier" = ${filter.tier}::"EventTier"`);
  if (filter.durability) conditions.push(Prisma.sql`"durability" = ${filter.durability}::"EventDurability"`);
  if (filter.actorId) conditions.push(Prisma.sql`"actorId" = ${filter.actorId}`);
  if (filter.outcome) conditions.push(Prisma.sql`"outcome" = ${filter.outcome}::"EventOutcome"`);
  if (filter.targetId) conditions.push(Prisma.sql`"targetId" = ${filter.targetId}`);
  if (filter.actorType) conditions.push(Prisma.sql`"actorType" = ${filter.actorType}::"RequestSource"`);
  if (filter.hiddenActorTypes) {
    const hidden = filter.hiddenActorTypes.map((value) => Prisma.sql`${value}::"RequestSource"`);
    conditions.push(Prisma.sql`"actorType" NOT IN (${Prisma.join(hidden)})`);
  }
  if (filter.from) conditions.push(Prisma.sql`"createdAt" >= ${filter.from}`);
  if (filter.to) conditions.push(Prisma.sql`"createdAt" <= ${filter.to}`);

  return conditions;
}
