import type { EventLogFilterQuery } from '@repo/api-client';
import { Prisma, type RequestSource } from '@repo/database';
import { describe, expect, it } from 'vitest';
import {
  toEventLogFilter,
  toEventLogSqlConditions,
  toEventLogWhere,
  type EventLogFilter,
} from '../event-log.filters';

const ORGANIZATION_ID = 'org-1';

const HIDDEN: readonly RequestSource[] = ['DEVICE', 'SYSTEM'];

const sqlOf = (query: EventLogFilterQuery) =>
  Prisma.join(toEventLogSqlConditions(toEventLogFilter(ORGANIZATION_ID, query)), ' AND ').sql;

const valuesOf = (query: EventLogFilterQuery) =>
  Prisma.join(toEventLogSqlConditions(toEventLogFilter(ORGANIZATION_ID, query)), ' AND ').values;

const whereOf = (query: EventLogFilterQuery) => toEventLogWhere(toEventLogFilter(ORGANIZATION_ID, query));

describe('event-log filter actor exclusivity', () => {
  it('accepts an explicit actor type on its own', () => {
    const filter: EventLogFilter = { organizationId: ORGANIZATION_ID, actorType: 'DEVICE' };

    expect(toEventLogWhere(filter).actorType).toBe('DEVICE');
  });

  it('accepts a hidden-actor exclusion on its own', () => {
    const filter: EventLogFilter = { organizationId: ORGANIZATION_ID, hiddenActorTypes: HIDDEN };

    expect(toEventLogWhere(filter).actorType).toEqual({ notIn: ['DEVICE', 'SYSTEM'] });
  });

  it('accepts neither', () => {
    const filter: EventLogFilter = { organizationId: ORGANIZATION_ID };

    expect(toEventLogWhere(filter).actorType).toBeUndefined();
  });

  it('rejects both together, so the two compilations cannot diverge', () => {
    const both = {
      organizationId: ORGANIZATION_ID,
      actorType: 'DEVICE',
      hiddenActorTypes: HIDDEN,
      // @ts-expect-error actorType and hiddenActorTypes are mutually exclusive
    } satisfies EventLogFilter;

    expect(both.actorType).toBe('DEVICE');
  });

  it('never emits both predicates for a filter the constructor produced', () => {
    const withActorType = toEventLogFilter(ORGANIZATION_ID, { actorType: 'DEVICE' });

    expect(withActorType.hiddenActorTypes).toBeUndefined();
    expect(toEventLogSqlConditions(withActorType).filter((c) => c.sql.includes('actorType'))).toHaveLength(1);
  });
});

describe('event-log filter compilation', () => {
  it('pins the organization in both compilations', () => {
    expect(whereOf({}).organizationId).toBe(ORGANIZATION_ID);
    expect(sqlOf({})).toContain('"organizationId" = ?');
    expect(valuesOf({})[0]).toBe(ORGANIZATION_ID);
  });

  it('hides device and system actors by default in both compilations', () => {
    expect(whereOf({}).actorType).toEqual({ notIn: ['DEVICE', 'SYSTEM'] });
    expect(sqlOf({})).toContain('"actorType" NOT IN');
    expect(valuesOf({})).toEqual([ORGANIZATION_ID, 'DEVICE', 'SYSTEM']);
  });

  it('drops the hidden-actor exclusion when system actors are requested', () => {
    expect(whereOf({ includeSystemActors: true }).actorType).toBeUndefined();
    expect(sqlOf({ includeSystemActors: true })).not.toContain('NOT IN');
  });

  it('lets an explicit actorType replace the default exclusion', () => {
    expect(whereOf({ actorType: 'SYSTEM' }).actorType).toBe('SYSTEM');
    expect(sqlOf({ actorType: 'SYSTEM' })).toContain('"actorType" = ?::"RequestSource"');
  });

  it('compiles a createdAt window in both compilations', () => {
    const from = new Date('2026-08-01T00:00:00.000Z');
    const to = new Date('2026-08-02T00:00:00.000Z');

    expect(whereOf({ from, to, includeSystemActors: true }).createdAt).toEqual({ gte: from, lte: to });
    expect(sqlOf({ from, to, includeSystemActors: true })).toContain('"createdAt" >= ? AND "createdAt" <= ?');
  });

  it('casts every enum column so a text-bound parameter still compares', () => {
    const query: EventLogFilterQuery = { tier: 'EVIDENCE', durability: 'ATOMIC', outcome: 'DENIED' };

    expect(sqlOf(query)).toContain('"tier" = ?::"EventTier"');
    expect(sqlOf(query)).toContain('"durability" = ?::"EventDurability"');
    expect(sqlOf(query)).toContain('"outcome" = ?::"EventOutcome"');
  });

  it('compiles every named filter into both representations', () => {
    const query: EventLogFilterQuery = {
      actionKey: 'member.removed',
      resource: 'member',
      tier: 'EVIDENCE',
      durability: 'ATOMIC',
      actorId: 'u-1',
      actorType: 'UI',
      outcome: 'SUCCEEDED',
      targetId: 'm-1',
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-02T00:00:00.000Z'),
    };

    expect(Object.keys(whereOf(query)).sort()).toEqual(
      ['organizationId', 'actionKey', 'resource', 'tier', 'durability', 'actorId', 'outcome', 'targetId', 'actorType', 'createdAt'].sort(),
    );
    expect(valuesOf(query)).toHaveLength(11);
  });
});
