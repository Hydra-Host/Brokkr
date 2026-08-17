import { describe, expect, it } from 'vitest';

import { netplanAtomSchema } from '../netplan.schema';

describe('netplanAtomSchema', () => {
  it('accepts valid yaml blob', () => {
    const atom = netplanAtomSchema.parse({ yaml: 'network:\n  version: 2\n' });
    expect(atom.yaml).toBe('network:\n  version: 2\n');
  });

  it('rejects extra fields', () => {
    expect(() => netplanAtomSchema.parse({ yaml: 'network: {}', extra: 'x' })).toThrow();
  });

  it('rejects missing yaml', () => {
    expect(() => netplanAtomSchema.parse({})).toThrow();
  });

  it('rejects empty yaml', () => {
    expect(() => netplanAtomSchema.parse({ yaml: '' })).toThrow();
  });

  it('rejects non-string yaml', () => {
    expect(() => netplanAtomSchema.parse({ yaml: 123 })).toThrow();
  });

  it('rejects null yaml', () => {
    expect(() => netplanAtomSchema.parse({ yaml: null })).toThrow();
  });
});
