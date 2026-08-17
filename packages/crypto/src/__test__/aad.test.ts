import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { REQUIRED_FIELDS, SUPPORTED_AAD_VERSIONS, VALID_DIRECTIONS, canonicalizeAad } from '../aad';

function baseAad(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aad_v: 1,
    zone_id: 'zone-test',
    queue_name: 'q.events',
    direction: 'hub_to_bridge',
    job_id: 'job-1',
    created_at: 1_730_000_000_000,
    ...overrides,
  };
}

describe('canonicalizeAad — encoding', () => {
  it('emits keys in lexicographic order', () => {
    const out = canonicalizeAad(baseAad());
    expect(out.toString('utf8')).toBe(
      '{"aad_v":1,"created_at":1730000000000,"direction":"hub_to_bridge","job_id":"job-1","queue_name":"q.events","zone_id":"zone-test"}',
    );
  });

  it('emits no whitespace between tokens', () => {
    const out = canonicalizeAad(baseAad()).toString('utf8');
    expect(out).not.toContain(': ');
    expect(out).not.toContain(', ');
    expect(out.startsWith('{')).toBe(true);
    expect(out.endsWith('}')).toBe(true);
  });

  it('emits integers as JSON numbers, not strings', () => {
    const out = canonicalizeAad(baseAad({ created_at: 42, aad_v: 1 })).toString('utf8');
    expect(out).toContain('"created_at":42');
    expect(out).toContain('"aad_v":1');
    expect(out).not.toContain('"created_at":"42"');
  });

  it('emits non-ASCII as raw UTF-8 (matches bridge ensure_ascii=False)', () => {
    const out = canonicalizeAad(baseAad({ zone_id: 'zöne-üñîçødé' }));
    expect(out.includes(Buffer.from('zöne-üñîçødé', 'utf8'))).toBe(true);
    expect(out.toString('utf8')).not.toContain('\\u00');
  });

  it('accepts empty job_id', () => {
    const out = canonicalizeAad(baseAad({ job_id: '' })).toString('utf8');
    expect(out).toContain('"job_id":""');
  });

  it('accepts very long zone_id', () => {
    const longZone = 'z-' + 'a'.repeat(4096);
    const out = canonicalizeAad(baseAad({ zone_id: longZone })).toString('utf8');
    expect(out).toContain(longZone);
  });

  it('produces byte-identical output for differently-ordered input', () => {
    const a = canonicalizeAad({
      zone_id: 'z',
      aad_v: 1,
      direction: 'bridge_to_hub',
      queue_name: 'q',
      created_at: 1,
      job_id: 'j',
    });
    const b = canonicalizeAad({
      aad_v: 1,
      queue_name: 'q',
      created_at: 1,
      job_id: 'j',
      zone_id: 'z',
      direction: 'bridge_to_hub',
    });
    expect(a.equals(b)).toBe(true);
  });

  it.each(['hub_to_bridge', 'bridge_to_hub'])('serialises direction %s with snake_case', (direction) => {
    const out = canonicalizeAad(baseAad({ direction })).toString('utf8');
    expect(out).toContain(`"direction":"${direction}"`);
  });
});

describe('canonicalizeAad — validation', () => {
  it('rejects non-objects', () => {
    expect(() => canonicalizeAad('not a dict')).toThrow(/aad must be an object/);
    expect(() => canonicalizeAad(null)).toThrow(/aad must be an object/);
    expect(() => canonicalizeAad([1, 2, 3])).toThrow(/aad must be an object/);
  });

  it('rejects missing required fields', () => {
    const aad = baseAad();
    delete aad.zone_id;
    expect(() => canonicalizeAad(aad)).toThrow(/missing required fields/);
  });

  it('rejects unexpected fields', () => {
    expect(() => canonicalizeAad({ ...baseAad(), extra: 'nope' })).toThrow(/unexpected fields/);
  });

  it('rejects unsupported aad_v', () => {
    expect(() => canonicalizeAad(baseAad({ aad_v: 2 }))).toThrow(/unsupported aad_v/);
  });

  it('rejects invalid direction', () => {
    expect(() => canonicalizeAad(baseAad({ direction: 'hubToBridge' }))).toThrow(/aad.direction must be one of/);
  });

  it('rejects string aad_v', () => {
    expect(() => canonicalizeAad(baseAad({ aad_v: '1' }))).toThrow(/aad.aad_v must be an integer/);
  });

  it('rejects boolean aad_v', () => {
    expect(() => canonicalizeAad(baseAad({ aad_v: true }))).toThrow(/aad.aad_v must be an integer/);
  });

  it('rejects float created_at', () => {
    expect(() => canonicalizeAad(baseAad({ created_at: 1.5 }))).toThrow(/aad.created_at must be an integer/);
  });

  it('rejects NaN created_at', () => {
    expect(() => canonicalizeAad(baseAad({ created_at: NaN }))).toThrow(/aad.created_at must be an integer/);
  });

  it('serialises near-2^53 created_at as plain digits (no exponent)', () => {
    const out = canonicalizeAad(baseAad({ created_at: Number.MAX_SAFE_INTEGER })).toString('utf8');
    expect(out).toContain('"created_at":9007199254740991');
    expect(out).not.toContain('e+');
  });

  it('rejects created_at above MAX_SAFE_INTEGER', () => {
    expect(() => canonicalizeAad(baseAad({ created_at: Number.MAX_SAFE_INTEGER + 1 }))).toThrow(
      /aad.created_at must be in/,
    );
  });

  it('rejects negative created_at', () => {
    expect(() => canonicalizeAad(baseAad({ created_at: -1 }))).toThrow(/aad.created_at must be in/);
  });

  it.each(['zone_id', 'queue_name', 'direction', 'job_id'])('rejects non-string %s', (field) => {
    expect(() => canonicalizeAad(baseAad({ [field]: 42 }))).toThrow(new RegExp(`aad.${field} must be a string`));
  });
});

describe('exported constants', () => {
  it('REQUIRED_FIELDS matches spec', () => {
    expect(new Set(REQUIRED_FIELDS)).toEqual(
      new Set(['aad_v', 'zone_id', 'queue_name', 'direction', 'job_id', 'created_at']),
    );
  });

  it('SUPPORTED_AAD_VERSIONS is [1]', () => {
    expect([...SUPPORTED_AAD_VERSIONS]).toEqual([1]);
  });

  it('VALID_DIRECTIONS is snake_case', () => {
    expect(new Set(VALID_DIRECTIONS)).toEqual(new Set(['hub_to_bridge', 'bridge_to_hub']));
  });
});
