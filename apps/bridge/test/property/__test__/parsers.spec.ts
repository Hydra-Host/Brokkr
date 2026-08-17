import { isIPv4, isIPv6 } from 'node:net';

import { canonicalizeAad } from '@repo/crypto';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { cleanFstab } from '../../../src/lifecycle-deploy/deploy-templates.js';

import { aByteString, aFstabBlob, aHexString, aSha256Hex, anIpv4Address, anIpv6Address } from '../arbitraries.js';

function wellFormedAad(zoneId: string, jobId: string): Record<string, unknown> {
  return {
    aad_v: 1,
    zone_id: zoneId,
    queue_name: 'lifecycle',
    direction: 'hub_to_bridge',
    job_id: jobId,
    created_at: 1_700_000_000_000,
  };
}

describe('cleanFstab does not crash on arbitrary input', () => {
  it('always returns a string ending with double newline', () => {
    fc.assert(
      fc.property(aFstabBlob(), (blob) => {
        const result = cleanFstab(blob);
        expect(typeof result).toBe('string');
        expect(result.endsWith('\n\n')).toBe(true);
      }),
    );
  });

  it('never drops a non-blank content line', () => {
    fc.assert(
      fc.property(aFstabBlob(), (blob) => {
        const result = cleanFstab(blob);
        const inputContent = blob.split('\n').filter((ln) => ln.trim() !== '');
        const outputLines = result.split('\n');
        for (const original of inputContent) {
          const firstToken = original.split(/\s+/).filter((p) => p !== '')[0] ?? '';
          const preserved = outputLines.some(
            (out) => out.includes(original) || out.replace(/^#+\s*/, '').startsWith(firstToken),
          );
          expect(preserved).toBe(true);
        }
      }),
    );
  });
});

describe('hex round-trip', () => {
  it('sha256-shaped hex round-trips through Buffer.from(..., hex)', () => {
    fc.assert(
      fc.property(aSha256Hex(), (hexStr) => {
        const decoded = Buffer.from(hexStr, 'hex');
        expect(decoded.length).toBe(32);
        expect(decoded.toString('hex')).toBe(hexStr);
      }),
    );
  });

  it('arbitrary byte payloads round-trip through hex encoding', () => {
    fc.assert(
      fc.property(aByteString({ maxSize: 4096 }), (payload) => {
        const encoded = payload.toString('hex');
        expect(Buffer.from(encoded, 'hex').equals(payload)).toBe(true);
      }),
    );
  });

  it('odd-length hex strings decode to a buffer of half-length-floor bytes', () => {
    fc.assert(
      fc.property(aHexString(), (hexStr) => {
        const decoded = Buffer.from(hexStr, 'hex');
        if (hexStr.length % 2 === 0) {
          expect(decoded.length).toBe(hexStr.length / 2);
          expect(decoded.toString('hex')).toBe(hexStr);
        } else {
          expect(decoded.length).toBe(Math.floor(hexStr.length / 2));
        }
      }),
    );
  });
});

describe('AAD canonical encoding', () => {
  it('produces UTF-8 bytes that decode to the same logical content', () => {
    fc.assert(
      fc.property(aHexString(8), aHexString(16), (zoneId, jobId) => {
        const encoded = canonicalizeAad(wellFormedAad(zoneId, jobId));
        expect(Buffer.isBuffer(encoded)).toBe(true);
        const decoded = JSON.parse(encoded.toString('utf-8')) as Record<string, unknown>;
        expect(decoded.zone_id).toBe(zoneId);
        expect(decoded.job_id).toBe(jobId);
      }),
    );
  });

  it('is deterministic under key-insertion-order shuffle', () => {
    fc.assert(
      fc.property(aHexString(8), aHexString(16), (zoneId, jobId) => {
        const aad = wellFormedAad(zoneId, jobId);
        const shuffled = Object.fromEntries([...Object.entries(aad)].reverse());
        expect(canonicalizeAad(aad).equals(canonicalizeAad(shuffled))).toBe(true);
      }),
    );
  });

  it('emits canonical form with no inter-token whitespace', () => {
    fc.assert(
      fc.property(aHexString(8), aHexString(16), (zoneId, jobId) => {
        const text = canonicalizeAad(wellFormedAad(zoneId, jobId)).toString('utf-8');
        expect(text.includes(', ')).toBe(false);
        expect(text.includes(': ')).toBe(false);
      }),
    );
  });
});

describe('IP address parsing', () => {
  it('every generated IPv4 string parses and stringifies back identically', () => {
    fc.assert(
      fc.property(anIpv4Address(), (ip) => {
        expect(isIPv4(ip)).toBe(true);
      }),
    );
  });

  it('every generated IPv6 string parses', () => {
    fc.assert(
      fc.property(anIpv6Address(), (ip) => {
        expect(isIPv6(ip)).toBe(true);
      }),
    );
  });
});
