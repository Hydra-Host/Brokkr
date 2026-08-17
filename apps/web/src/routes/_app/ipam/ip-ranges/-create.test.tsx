import { describe, expect, it } from 'vitest';
import { filterPrefixesByZone } from '~/components/fk-comboboxes';
import { UNASSIGNED_ZONE_VALUE, zoneFilterFromSelection } from './create';

describe('zoneFilterFromSelection (zone select → prefix combobox filter)', () => {
  it('applies no filter before a zone is chosen', () => {
    expect(zoneFilterFromSelection('')).toBeUndefined();
  });

  it('maps the unassigned option to the null-zone filter', () => {
    expect(zoneFilterFromSelection(UNASSIGNED_ZONE_VALUE)).toBeNull();
  });

  it('passes a real zone id through unchanged', () => {
    expect(zoneFilterFromSelection('zone-1')).toBe('zone-1');
  });

  it('keeps zone-less prefixes reachable via the unassigned option', () => {
    const prefixes = [
      { id: 'p-zoned', zoneId: 'zone-1' },
      { id: 'p-orphan', zoneId: null },
    ];
    const visible = filterPrefixesByZone(prefixes, zoneFilterFromSelection(UNASSIGNED_ZONE_VALUE));
    expect(visible.map((p) => p.id)).toEqual(['p-orphan']);
  });
});
