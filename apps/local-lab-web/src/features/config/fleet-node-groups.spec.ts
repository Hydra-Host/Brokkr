import { describe, expect, it } from 'vitest';

import { groupByZone } from './fleet-node-groups';

const node = (name: string, zone: string) => ({ name, zone });
const zoneOf = (item: { zone: string }) => item.zone;

describe('groupByZone', () => {
  it('keeps the declared render order rather than sorting by name', () => {
    const groups = groupByZone([node('a', 'z1'), node('b', 'z0')], zoneOf, ['z0', 'z1']);

    expect(groups.map((g) => g.zone)).toEqual(['z0', 'z1']);
  });

  it('keeps a declared zone that holds nothing, so an empty zone stays visible', () => {
    const groups = groupByZone([node('a', 'z0')], zoneOf, ['z0', 'z1']);

    expect(groups).toHaveLength(2);
    expect(groups[1]).toEqual({ zone: 'z1', items: [], undeclared: false });
  });

  it('puts a zone nothing declares last and flags it rather than dropping the node', () => {
    const groups = groupByZone([node('a', 'z0'), node('orphan', 'gone')], zoneOf, ['z0']);

    expect(groups.map((g) => g.zone)).toEqual(['z0', 'gone']);
    expect(groups[1].undeclared).toBe(true);
    expect(groups[1].items.map((i) => i.name)).toEqual(['orphan']);
  });

  it('collapses several nodes in one undeclared zone into a single group', () => {
    const groups = groupByZone([node('a', 'gone'), node('b', 'gone')], zoneOf, []);

    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(2);
  });

  it('loses no node, whatever its zone', () => {
    const items = [node('a', 'z0'), node('b', 'z1'), node('c', 'gone')];

    const groups = groupByZone(items, zoneOf, ['z0', 'z1']);

    expect(groups.flatMap((g) => g.items)).toHaveLength(items.length);
  });
});
