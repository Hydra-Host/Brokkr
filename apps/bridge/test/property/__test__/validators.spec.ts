import { isIP } from 'node:net';

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sanitizeRedisUrl } from '../../../src/common/redis/redis-client/url-sanitize.js';
import {
  IPMIValidationError,
  validateCommandPart,
  validateIp,
  validatePort,
  validateUsername,
} from '../../../src/oob/ipmi/validation.js';

import { aMacAddress, anIpv4Address, anIpv6Address } from '../arbitraries.js';

describe('sanitizeRedisUrl', () => {
  it('handles arbitrary passwords without crashing', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{1,12}$/),
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.stringMatching(/^[a-z][a-z0-9-]{0,30}$/),
        fc.integer({ min: 1, max: 65535 }),
        (user, pw, host, port) => {
          const raw = `redis://${user}:${pw}@${host}:${port}/0`;
          const sanitized = sanitizeRedisUrl(raw);
          const parsed = new URL(sanitized);
          expect(parsed.hostname).toBe(host);
          expect(parsed.port).toBe(String(port));
        },
      ),
    );
  });

  it('is total over arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 128 }), (url) => {
        const result = sanitizeRedisUrl(url);
        expect(typeof result).toBe('string');
      }),
    );
  });

  it('passes through URLs without credentials untouched', () => {
    const raw = 'redis://localhost:6379/0';
    expect(sanitizeRedisUrl(raw)).toBe(raw);
  });
});

describe('validateIp', () => {
  it('accepts every well-formed IPv4 address', () => {
    fc.assert(
      fc.property(anIpv4Address(), (ip) => {
        expect(validateIp(ip)).toBe(ip);
      }),
    );
  });

  it('accepts every well-formed IPv6 address (canonical compressed form)', () => {
    fc.assert(
      fc.property(anIpv6Address(), (ip) => {
        const result = validateIp(ip);
        expect(isIP(result)).toBe(6);
      }),
    );
  });

  it('rejects strings that do not parse as IPs', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 32 }).filter((s) => isIP(s.trim()) === 0),
        (garbage) => {
          expect(() => validateIp(garbage)).toThrow(IPMIValidationError);
        },
      ),
    );
  });
});

describe('validatePort', () => {
  it('accepts integers in [1, 65535]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 65535 }), (port) => {
        expect(validatePort(port)).toBe(port);
      }),
    );
  });

  it('rejects integers outside [1, 65535]', () => {
    fc.assert(
      fc.property(
        fc.integer().filter((n) => n < 1 || n > 65535),
        (port) => {
          expect(() => validatePort(port)).toThrow(IPMIValidationError);
        },
      ),
    );
  });

  it('rejects non-numeric junk with a typed error', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ minLength: 1, maxLength: 10 }).filter((s) => !/^[+-]?\d(_?\d)*$/.test(s)),
          fc.constant(null),
        ),
        (junk) => {
          expect(() => validatePort(junk)).toThrow(IPMIValidationError);
        },
      ),
    );
  });
});

const DANGEROUS_CHARS = [';', '&', '|', '`', '$', '(', ')', '{', '}', '[', ']', '<', '>'];

describe('validateCommandPart', () => {
  it('accepts lower-alphanumerics + `_-` (no leading dash)', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z0-9_-]{1,16}$/).filter((s) => !s.startsWith('-')),
        (part) => {
          expect(validateCommandPart(part)).toBe(part);
        },
      ),
    );
  });

  it('rejects any shell metacharacter', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[abc123]{1,8}$/), fc.constantFrom(...DANGEROUS_CHARS), (base, bad) => {
        expect(() => validateCommandPart(base + bad)).toThrow(IPMIValidationError);
      }),
    );
  });

  it('rejects `..` path-traversal anywhere in the part', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 4 }), (pos) => {
        const part = 'a'.repeat(pos) + '..' + 'b'.repeat(4 - pos);
        expect(() => validateCommandPart(part)).toThrow(IPMIValidationError);
      }),
    );
  });

  it('rejects a leading dash', () => {
    expect(() => validateCommandPart('-rm')).toThrow(IPMIValidationError);
  });
});

describe('validateUsername', () => {
  it('accepts alphanumerics + underscore', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z0-9_]{1,32}$/), (name) => {
        expect(validateUsername(name)).toBe(name);
      }),
    );
  });

  it('rejects disallowed characters', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[!@#%^*+=]{1,16}$/).map((s) => 'x' + s),
        (name) => {
          expect(() => validateUsername(name)).toThrow(IPMIValidationError);
        },
      ),
    );
  });
});

describe('MAC strategy smoke (sanity for downstream consumers)', () => {
  it('every generated MAC has six lowercase hex octets', () => {
    fc.assert(
      fc.property(aMacAddress(), (mac) => {
        const parts = mac.split(':');
        expect(parts).toHaveLength(6);
        for (const octet of parts) {
          expect(octet.length).toBe(2);
          expect(Number.isNaN(parseInt(octet, 16))).toBe(false);
        }
      }),
    );
  });
});
