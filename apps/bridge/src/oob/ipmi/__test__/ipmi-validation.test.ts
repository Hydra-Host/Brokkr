import { describe, expect, it } from 'vitest';

import {
  IPMIValidationError,
  validateCommandPart,
  validateIp,
  validateIpmiCommand,
  validatePort,
  validateUsername,
} from '../validation.js';

describe('validateIp', () => {
  it('accepts canonical IPv4', () => {
    expect(validateIp('10.0.0.1')).toBe('10.0.0.1');
  });

  it('accepts canonical IPv6', () => {
    expect(validateIp('fd00::1')).toBe('fd00::1');
  });

  it('strips surrounding whitespace', () => {
    expect(validateIp('  10.0.0.1  ')).toBe('10.0.0.1');
  });

  it('rejects garbage input', () => {
    expect(() => validateIp('not-an-ip')).toThrow(IPMIValidationError);
  });
});

describe('validateUsername', () => {
  it('accepts a simple identifier', () => {
    expect(validateUsername('admin')).toBe('admin');
  });

  it('accepts a vault secret macro', () => {
    expect(validateUsername('{VAULT:"path":key}')).toBe('{VAULT:"path":key}');
  });

  it('rejects empty', () => {
    expect(() => validateUsername('')).toThrow(IPMIValidationError);
  });

  it('rejects too-long usernames', () => {
    expect(() => validateUsername('a'.repeat(200))).toThrow(IPMIValidationError);
  });

  it('rejects shell metacharacters', () => {
    expect(() => validateUsername('admin;rm')).toThrow(IPMIValidationError);
  });
});

describe('validatePort', () => {
  it('accepts an integer', () => {
    expect(validatePort(623)).toBe(623);
  });

  it('accepts a string integer', () => {
    expect(validatePort('623')).toBe(623);
  });

  it('rejects out-of-range', () => {
    expect(() => validatePort(70000)).toThrow(IPMIValidationError);
  });

  it('rejects zero', () => {
    expect(() => validatePort(0)).toThrow(IPMIValidationError);
  });

  it('rejects non-numeric strings', () => {
    expect(() => validatePort('not-a-number')).toThrow(IPMIValidationError);
  });
});

describe('validateCommandPart', () => {
  it('accepts a simple subcommand', () => {
    expect(validateCommandPart('status')).toBe('status');
  });

  it.each([['a;b'], ['a|b'], ['a&b'], ['a`b'], ['a$b'], ['../etc'], ['-flag'], ['a\nb'], ['a\\x41']])(
    'rejects shell-meta input %p',
    (dangerous) => {
      expect(() => validateCommandPart(dangerous)).toThrow(IPMIValidationError);
    },
  );

  it('rejects empty', () => {
    expect(() => validateCommandPart('')).toThrow(IPMIValidationError);
  });
});

describe('validateIpmiCommand', () => {
  it('accepts chassis status', () => {
    expect(validateIpmiCommand(['chassis', 'status'])).toEqual(['chassis', 'status']);
  });

  it('accepts sdr type temperature', () => {
    expect(validateIpmiCommand(['sdr', 'type', 'temperature'])).toEqual(['sdr', 'type', 'temperature']);
  });

  it('accepts dcmi power reading', () => {
    expect(validateIpmiCommand(['dcmi', 'power', 'reading'])).toEqual(['dcmi', 'power', 'reading']);
  });

  it('accepts chassis power status', () => {
    expect(validateIpmiCommand(['chassis', 'power', 'status'])).toEqual(['chassis', 'power', 'status']);
  });

  it('accepts user list with valid channel', () => {
    expect(validateIpmiCommand(['user', 'list', '1'])).toEqual(['user', 'list', '1']);
  });

  it('rejects an unknown base command', () => {
    expect(() => validateIpmiCommand(['rm', 'rf'])).toThrow(/not allowed/);
  });

  it('rejects an unknown subcommand', () => {
    expect(() => validateIpmiCommand(['chassis', 'destroy'])).toThrow(/not allowed/);
  });

  it('rejects an unknown SDR type', () => {
    expect(() => validateIpmiCommand(['sdr', 'type', 'kitchen-sink'])).toThrow(/SDR type/);
  });

  it('rejects an out-of-range channel', () => {
    expect(() => validateIpmiCommand(['user', 'list', '99'])).toThrow(/Channel/);
  });

  it('rejects an empty command', () => {
    expect(() => validateIpmiCommand([])).toThrow(IPMIValidationError);
  });
});
