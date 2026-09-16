import { describe, expect, it } from 'vitest';

import { coerceOption, RESERVED_OPTION_PREFIXES } from '../overlay-store';

describe('coerceOption', () => {
  it('types a bool from the two literals and refuses anything else', () => {
    expect(coerceOption({ kind: 'bool', bounds: null, choices: [], overrideFrom: null }, 'true')).toBe(true);
    expect(coerceOption({ kind: 'bool', bounds: null, choices: [], overrideFrom: null }, 'false')).toBe(false);
    expect(coerceOption({ kind: 'bool', bounds: null, choices: [], overrideFrom: null }, 'yes')).toBeUndefined();
    expect(coerceOption({ kind: 'bool', bounds: null, choices: [], overrideFrom: null }, '1')).toBeUndefined();
  });

  it('takes an integer and refuses a fraction or a word', () => {
    expect(coerceOption({ kind: 'number', bounds: null, choices: [], overrideFrom: null }, '7')).toBe(7);
    expect(coerceOption({ kind: 'number', bounds: null, choices: [], overrideFrom: null }, '7.5')).toBeUndefined();
    expect(coerceOption({ kind: 'number', bounds: null, choices: [], overrideFrom: null }, 'seven')).toBeUndefined();
  });

  it('refuses a number outside the range its nix type declares', () => {
    const bounded = { kind: 'number' as const, bounds: { min: 1, max: 4 }, choices: [], overrideFrom: null };

    expect(coerceOption(bounded, '4')).toBe(4);
    expect(coerceOption(bounded, '1')).toBe(1);
    expect(coerceOption(bounded, '9999')).toBeUndefined();
    expect(coerceOption(bounded, '0')).toBeUndefined();
  });

  it('takes any integer when the type declares no range, since an env knob is a string in nix', () => {
    expect(coerceOption({ kind: 'number', bounds: null, choices: [], overrideFrom: null }, '9999')).toBe(9999);
  });

  it('bounds a port to the tcp range', () => {
    expect(coerceOption({ kind: 'port', bounds: null, choices: [], overrideFrom: null }, '5432')).toBe(5432);
    expect(coerceOption({ kind: 'port', bounds: null, choices: [], overrideFrom: null }, '0')).toBeUndefined();
    expect(coerceOption({ kind: 'port', bounds: null, choices: [], overrideFrom: null }, '65536')).toBeUndefined();
  });

  it('refuses a blank for a number and a port rather than typing it as zero', () => {
    expect(coerceOption({ kind: 'number', bounds: null, choices: [], overrideFrom: null }, '')).toBeUndefined();
    expect(coerceOption({ kind: 'number', bounds: { min: 1, max: 10 }, choices: [], overrideFrom: null }, '')).toBeUndefined();
    expect(coerceOption({ kind: 'port', bounds: null, choices: [], overrideFrom: null }, '')).toBeUndefined();
  });

  it('passes text through, including a blank, because blank is a value', () => {
    expect(coerceOption({ kind: 'text', bounds: null, choices: [], overrideFrom: null }, 'warn')).toBe('warn');
    expect(coerceOption({ kind: 'text', bounds: null, choices: [], overrideFrom: null }, '')).toBe('');
  });

  const optionSelect = {
    kind: 'select' as const,
    bounds: null,
    choices: ['loopback', 'direct', 'fronted'],
    overrideFrom: null,
  };
  const envSelect = { ...optionSelect, overrideFrom: 'stackOverrides.hub' };

  it('takes a select value the catalog lists', () => {
    expect(coerceOption(optionSelect, 'direct')).toBe('direct');
  });

  it('refuses a value the enum does not list, since nix would fail to evaluate that line', () => {
    expect(coerceOption(optionSelect, 'anything')).toBeUndefined();
    expect(coerceOption(optionSelect, '')).toBeUndefined();
    expect(coerceOption(optionSelect, 'Direct')).toBeUndefined();
  });

  it('refuses every value for an enum whose catalog entry carries no choices', () => {
    expect(coerceOption({ ...optionSelect, choices: [] }, 'direct')).toBeUndefined();
  });

  it('passes an env-attrset select through unchecked, because its choices are advisory strings', () => {
    expect(coerceOption(envSelect, 'anything')).toBe('anything');
    expect(coerceOption(envSelect, '   ')).toBe('   ');
  });
});

describe('RESERVED_OPTION_PREFIXES', () => {
  it('covers every family a typed writer owns', () => {
    for (const path of [
      'stackDefaults.hub.LOG_LEVEL',
      'stackDefaults.spoke.LOG_LEVEL',
      'ports.postgres',
      'identity.pg.user',
      'osLayerCache.resolvers',
      'identity.redis.password',
      'identity.mailpit.password',
      'lan.mode',
      'lan.bindAddress',
      'lan.datastoreAuth',
      'lan.expose',
      'telemetry.enable',
      'stack.slot',
      'stackCounts.spoke',
      'fleet.autoStart',
    ]) {
      expect(RESERVED_OPTION_PREFIXES.some((prefix) => path.startsWith(prefix))).toBe(true);
    }
  });

  it('leaves a path no typed writer owns to the generic writer', () => {
    for (const path of ['zoneCrypto.bridgeAtRestKey', 'redisAcl.enable', 'vrrpSim.enable', 'polyrepo.hub.path']) {
      expect(RESERVED_OPTION_PREFIXES.some((prefix) => path.startsWith(prefix))).toBe(false);
    }
  });

  it('names no prefix that matches nothing, so the list cannot rot silently', () => {
    expect(RESERVED_OPTION_PREFIXES.filter((prefix) => prefix.trim() === '')).toEqual([]);
  });
});
