
import { isIP, isIPv4, isIPv6 } from 'node:net';

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  aByteString,
  aFstabBlob,
  aFstabLine,
  aHexString,
  aMacAddress,
  aSha256Hex,
  anAadDict,
  anAadDictWithInvalidValue,
  anIpv4Address,
  anIpv4Cidr,
  anIpv6Address,
} from '../arbitraries.js';

const MAC_RE = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

describe('arbitraries smoke', () => {
  it('aByteString returns Buffer', () => {
    fc.assert(
      fc.property(aByteString(), (value) => {
        expect(Buffer.isBuffer(value)).toBe(true);
      }),
    );
  });

  it('aHexString returns lowercase hex', () => {
    fc.assert(
      fc.property(aHexString(), (value) => {
        expect(typeof value).toBe('string');
        for (const c of value) {
          expect('0123456789abcdef').toContain(c);
        }
      }),
    );
  });

  it('aSha256Hex returns 64-char hex', () => {
    fc.assert(
      fc.property(aSha256Hex(), (value) => {
        expect(value).toHaveLength(64);
        for (const c of value) {
          expect('0123456789abcdef').toContain(c);
        }
      }),
    );
  });

  it('anIpv4Address returns a parseable address', () => {
    fc.assert(
      fc.property(anIpv4Address(), (value) => {
        expect(isIPv4(value)).toBe(true);
      }),
    );
  });

  it('anIpv6Address returns a parseable address', () => {
    fc.assert(
      fc.property(anIpv6Address(), (value) => {
        expect(isIPv6(value)).toBe(true);
      }),
    );
  });

  it('anIpv4Cidr returns parseable address/prefix', () => {
    fc.assert(
      fc.property(anIpv4Cidr(), (value) => {
        const [ip, prefix] = value.split('/');
        expect(isIPv4(ip!)).toBe(true);
        const n = Number(prefix);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(32);
      }),
    );
  });

  it('aMacAddress returns six lowercase hex octets', () => {
    fc.assert(
      fc.property(aMacAddress(), (value) => {
        expect(MAC_RE.test(value)).toBe(true);
      }),
    );
  });

  it('aFstabLine has six whitespace-delimited fields', () => {
    fc.assert(
      fc.property(aFstabLine(), (value) => {
        const fields = value.split(/\s+/).filter((f) => f !== '');
        expect(fields).toHaveLength(6);
      }),
    );
  });

  it('aFstabBlob is a string', () => {
    fc.assert(
      fc.property(aFstabBlob(), (value) => {
        expect(typeof value).toBe('string');
      }),
    );
  });

  it('anAadDict has scalar values only', () => {
    fc.assert(
      fc.property(anAadDict(), (value) => {
        for (const [key, val] of Object.entries(value)) {
          expect(typeof key).toBe('string');
          const isScalar =
            typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean' || val === null;
          expect(isScalar).toBe(true);
        }
      }),
    );
  });

  it('anAadDictWithInvalidValue contains at least one value the canonicalizer rejects', () => {
    fc.assert(
      fc.property(anAadDictWithInvalidValue(), (value) => {
        const anyBad = Object.values(value).some((v) => {
          if (Array.isArray(v)) return true;
          if (Buffer.isBuffer(v)) return true;
          if (typeof v === 'object' && v !== null) return true;
          return false;
        });
        expect(anyBad).toBe(true);
      }),
    );
  });
});

void isIP;
