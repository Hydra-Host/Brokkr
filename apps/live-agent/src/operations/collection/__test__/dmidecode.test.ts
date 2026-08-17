import { describe, expect, it } from 'vitest';
import { validateDmidecode } from '.././dmidecode';
import { validateDmidecodeMemory } from '.././memory';

const happy = [
  { handle: '0x0000', type: 0, bytes: 24, description: 'BIOS Information', values: { vendor: 'ACME' } },
  { handle: '0x0001', type: 1, bytes: 27, description: 'System Information', values: { manufacturer: 'ACME' } },
];

const typeDivergent = [
  { handle: '0x1100', type: '17', bytes: '40', description: 'Memory Device', values: { size: '32 GB' } },
];

describe('validateDmidecode', () => {
  it('returns parsed records for a conformant payload', () => {
    expect(validateDmidecode(happy)).toEqual(happy);
  });

  it('delivers the raw payload when a field type diverges instead of throwing', () => {
    expect(() => validateDmidecode(typeDivergent)).not.toThrow();
    expect(validateDmidecode(typeDivergent)).toEqual(typeDivergent);
  });

  it('delivers a non-array payload opaque rather than failing the collector', () => {
    const weird = { unexpected: 'shape' };
    expect(validateDmidecode(weird)).toEqual(weird);
  });
});

describe('validateDmidecodeMemory', () => {
  it('returns parsed records for a conformant payload', () => {
    expect(validateDmidecodeMemory(happy)).toEqual(happy);
  });

  it('delivers the raw payload when bytes/type diverge instead of throwing', () => {
    expect(() => validateDmidecodeMemory(typeDivergent)).not.toThrow();
    expect(validateDmidecodeMemory(typeDivergent)).toEqual(typeDivergent);
  });
});
