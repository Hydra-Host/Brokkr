import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { managedTagForSlot } from '../managed-tag';

const SIM = join(__dirname, '..', '..', '..', '..', 'local-sim', 'scripts', 'local');
const DERIVED_PY = join(SIM, 'derived.py');
const FLEET_PY = join(SIM, 'fleet.py');

function pythonReturnExpression(): string {
  const src = readFileSync(DERIVED_PY, 'utf8');
  const match = src.match(/def managed_tag_for_slot\(slot: int\) -> str:[\s\S]*?\n {4}return (.+)\n/);
  if (!match) throw new Error(`managed_tag_for_slot not found in ${DERIVED_PY}`);
  return match[1].trim();
}

function pythonTagForSlot(slot: number): string {
  const expr = pythonReturnExpression();
  const match = expr.match(/^"([^"]*)" if slot == 0 else f"([^"{]*)\{slot\}"$/);
  if (!match) throw new Error(`unrecognised managed_tag_for_slot expression: ${expr}`);
  return slot === 0 ? match[1] : `${match[2]}${slot}`;
}

describe('managedTagForSlot parity with the python simulator engine', () => {
  it('returns the same tag as derived.py for every slot', () => {
    for (const slot of [0, 1, 2, 3, 9, 17]) {
      expect(managedTagForSlot(slot)).toBe(pythonTagForSlot(slot));
    }
  });

  it('keeps the legacy untagged value on slot 0 and a distinct suffix elsewhere', () => {
    expect(managedTagForSlot(0)).toBe('brokkr-local');
    expect(managedTagForSlot(1)).toBe('brokkr-local-s1');
    expect(managedTagForSlot(1).startsWith(managedTagForSlot(0))).toBe(true);
  });

  it('matches the angle-bracket framing fleet.py disambiguates sibling slots with', () => {
    expect(readFileSync(FLEET_PY, 'utf8')).toContain('f">{tag}<"');
  });
});
