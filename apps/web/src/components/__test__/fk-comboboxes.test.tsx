import { describe, expect, it } from 'vitest';
import { filterPrefixesByZone } from '../fk-comboboxes';

const prefixes = [
  { id: 'p-a1', zoneId: 'zone-a' },
  { id: 'p-a2', zoneId: 'zone-a' },
  { id: 'p-b1', zoneId: 'zone-b' },
  { id: 'p-none', zoneId: null },
];

describe('filterPrefixesByZone (PrefixCombobox zone filter)', () => {
  it('returns every prefix when no zone filter is given', () => {
    expect(filterPrefixesByZone(prefixes, undefined)).toEqual(prefixes);
  });

  it('returns only the prefixes assigned to the given zone', () => {
    expect(filterPrefixesByZone(prefixes, 'zone-a').map((p) => p.id)).toEqual(['p-a1', 'p-a2']);
  });

  it('returns only zone-unassigned prefixes for the null filter', () => {
    expect(filterPrefixesByZone(prefixes, null).map((p) => p.id)).toEqual(['p-none']);
  });

  it('returns nothing for a zone with no prefixes', () => {
    expect(filterPrefixesByZone(prefixes, 'zone-empty')).toEqual([]);
  });
});
