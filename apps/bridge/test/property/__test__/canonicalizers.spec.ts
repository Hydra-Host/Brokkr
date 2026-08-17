import { canonicalizeAad } from '@repo/crypto';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { cleanFstab } from '../../../src/lifecycle-deploy/deploy-templates.js';
import { coerceStatus } from '../../../src/saga-framework/state.service.js';
import { JobStatus, TERMINAL_STATUSES } from '../../../src/saga-framework/state.types.js';

import { aFstabBlob, aHexString, anAadDict } from '../arbitraries.js';

function wfAad(zoneId: string, jobId: string, createdAt = 1_700_000_000_000): Record<string, unknown> {
  return {
    aad_v: 1,
    zone_id: zoneId,
    queue_name: 'lifecycle',
    direction: 'hub_to_bridge',
    job_id: jobId,
    created_at: createdAt,
  };
}

describe('cleanFstab idempotency', () => {
  it('reaches a fixed point after two applications', () => {
    fc.assert(
      fc.property(aFstabBlob(), (blob) => {
        const twice = cleanFstab(cleanFstab(blob));
        const thrice = cleanFstab(twice);
        expect(twice.replace(/\n+$/, '')).toBe(thrice.replace(/\n+$/, ''));
      }),
    );
  });
});

describe('canonicalizeAad', () => {
  it('produces identical bytes regardless of key-insertion order', () => {
    fc.assert(
      fc.property(aHexString(8), aHexString(16), fc.integer({ min: 0, max: 2 ** 40 }), (zoneId, jobId, createdAt) => {
        const a = wfAad(zoneId, jobId, createdAt);
        const b = Object.fromEntries([...Object.entries(a)].reverse());
        const c = Object.fromEntries([...Object.entries(a)].sort(([k1], [k2]) => k1.localeCompare(k2)));
        const encA = canonicalizeAad(a);
        const encB = canonicalizeAad(b);
        const encC = canonicalizeAad(c);
        expect(encA.equals(encB)).toBe(true);
        expect(encA.equals(encC)).toBe(true);
      }),
    );
  });

  it('is idempotent via JSON-decode round-trip', () => {
    fc.assert(
      fc.property(aHexString(8), aHexString(16), (zoneId, jobId) => {
        const aad = wfAad(zoneId, jobId);
        const once = canonicalizeAad(aad);
        const decoded = JSON.parse(once.toString('utf-8')) as Record<string, unknown>;
        const twice = canonicalizeAad(decoded);
        expect(once.equals(twice)).toBe(true);
      }),
    );
  });

  it('rejects supersets of the six required fields', () => {
    const baseKeys = new Set(['aad_v', 'zone_id', 'queue_name', 'direction', 'job_id', 'created_at']);
    fc.assert(
      fc.property(anAadDict(), (extra) => {
        const spurious: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(extra)) {
          if (!baseKeys.has(k)) {
            spurious[k] = v;
          }
        }
        if (Object.keys(spurious).length === 0) {
          return;
        }
        const base = wfAad('deadbeef', '00112233445566778899aabbccddeeff');
        expect(() => canonicalizeAad({ ...base, ...spurious })).toThrow();
      }),
    );
  });
});

describe('coerceStatus is total', () => {
  it('returns a JobStatus for arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 64 }), (raw) => {
        const result = coerceStatus(raw);
        expect(Object.values(JobStatus)).toContain(result);
      }),
    );
  });

  it('returns a JobStatus for arbitrary scalars', () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant(null), fc.integer(), fc.string({ maxLength: 32 }), fc.boolean()), (raw) => {
        const result = coerceStatus(raw);
        expect(Object.values(JobStatus)).toContain(result);
      }),
    );
  });

  it('round-trips known string values', () => {
    fc.assert(
      fc.property(fc.constantFrom('pending', 'running', 'complete', 'failed', 'cancelled'), (status) => {
        expect(coerceStatus(status)).toBe(status);
      }),
    );
  });
});

describe('terminal-state monotonicity', () => {
  it('classifies complete/failed/cancelled as terminal', () => {
    fc.assert(
      fc.property(fc.constantFrom('complete', 'failed', 'cancelled'), (s) => {
        expect(TERMINAL_STATUSES.has(coerceStatus(s))).toBe(true);
      }),
    );
  });

  it('classifies pending/running as non-terminal', () => {
    fc.assert(
      fc.property(fc.constantFrom('pending', 'running'), (s) => {
        expect(TERMINAL_STATUSES.has(coerceStatus(s))).toBe(false);
      }),
    );
  });

  it('unknown values fall back to PENDING', () => {
    const known = new Set(['pending', 'running', 'complete', 'failed', 'cancelled']);
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !known.has(s)),
        (garbage) => {
          expect(coerceStatus(garbage)).toBe(JobStatus.PENDING);
        },
      ),
    );
  });
});
