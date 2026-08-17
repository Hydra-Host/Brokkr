import { afterEach, describe, expect, it } from 'vitest';

import { diffBiosPendingParams, redfishBoolMatches } from '../vendor/base/base.js';

afterEach(() => {});

describe('redfishBoolMatches', () => {
  it('exact boolean match true/true returns true', () => {
    expect(redfishBoolMatches(true, true)).toBe(true);
  });

  it('exact boolean match false/false returns true', () => {
    expect(redfishBoolMatches(false, false)).toBe(true);
  });

  it('mismatched booleans true/false returns false', () => {
    expect(redfishBoolMatches(true, false)).toBe(false);
  });

  it('mismatched booleans false/true returns false', () => {
    expect(redfishBoolMatches(false, true)).toBe(false);
  });

  it('numeric 1 with desired true returns true', () => {
    expect(redfishBoolMatches(1, true)).toBe(true);
  });

  it('numeric 0 with desired false returns true', () => {
    expect(redfishBoolMatches(0, false)).toBe(true);
  });

  it('numeric 1 with desired false returns false', () => {
    expect(redfishBoolMatches(1, false)).toBe(false);
  });

  it('numeric 0 with desired true returns false', () => {
    expect(redfishBoolMatches(0, true)).toBe(false);
  });

  it('string current returns false regardless of desired', () => {
    expect(redfishBoolMatches('true', true)).toBe(false);
    expect(redfishBoolMatches('1', true)).toBe(false);
    expect(redfishBoolMatches('false', false)).toBe(false);
  });

  it('undefined current returns false', () => {
    expect(redfishBoolMatches(undefined, true)).toBe(false);
    expect(redfishBoolMatches(undefined, false)).toBe(false);
  });

  it('null current returns false', () => {
    expect(redfishBoolMatches(null, true)).toBe(false);
    expect(redfishBoolMatches(null, false)).toBe(false);
  });
});

describe('diffBiosPendingParams', () => {
  it('excludes entry equal to current (exact match)', () => {
    const pending: [string, unknown][] = [['VTEnabled', 'Enabled']];
    const current = { VTEnabled: 'Enabled' };
    expect(diffBiosPendingParams(pending, current)).toEqual({});
  });

  it('includes entry that differs from current', () => {
    const pending: [string, unknown][] = [['VTEnabled', 'Enabled']];
    const current = { VTEnabled: 'Disabled' };
    const result = diffBiosPendingParams(pending, current);
    expect(result).toEqual({ VTEnabled: 'Enabled' });
  });

  it('returned value is the pending value, not the current value', () => {
    const pending: [string, unknown][] = [['Setting', 'NewValue']];
    const current = { Setting: 'OldValue' };
    const result = diffBiosPendingParams(pending, current);
    expect(result['Setting']).toBe('NewValue');
  });

  it('bool true is loosely equal to number 1 (excluded)', () => {
    const pending: [string, unknown][] = [['HT', true]];
    const current = { HT: 1 };
    expect(diffBiosPendingParams(pending, current)).toEqual({});
  });

  it('bool false is loosely equal to number 0 (excluded)', () => {
    const pending: [string, unknown][] = [['HT', false]];
    const current = { HT: 0 };
    expect(diffBiosPendingParams(pending, current)).toEqual({});
  });

  it('number 1 is loosely equal to bool true (excluded)', () => {
    const pending: [string, unknown][] = [['HT', 1]];
    const current = { HT: true };
    expect(diffBiosPendingParams(pending, current)).toEqual({});
  });

  it('number 0 is loosely equal to bool false (excluded)', () => {
    const pending: [string, unknown][] = [['HT', 0]];
    const current = { HT: false };
    expect(diffBiosPendingParams(pending, current)).toEqual({});
  });

  it('includes entry whose key is absent from current', () => {
    const pending: [string, unknown][] = [['NewKey', 'Value']];
    const current = {};
    const result = diffBiosPendingParams(pending, current);
    expect(result).toEqual({ NewKey: 'Value' });
  });

  it('excludes deeply-equal object values', () => {
    const pending: [string, unknown][] = [['Nested', { a: 1, b: 2 }]];
    const current = { Nested: { a: 1, b: 2 } };
    expect(diffBiosPendingParams(pending, current)).toEqual({});
  });

  it('excludes deeply-equal array values', () => {
    const pending: [string, unknown][] = [['List', ['x', 'y']]];
    const current = { List: ['x', 'y'] };
    expect(diffBiosPendingParams(pending, current)).toEqual({});
  });

  it('mixes excluded and included entries correctly', () => {
    const pending: [string, unknown][] = [
      ['Same', 'SameValue'],
      ['Different', 'NewValue'],
      ['Missing', 42],
    ];
    const current = { Same: 'SameValue', Different: 'OldValue' };
    const result = diffBiosPendingParams(pending, current);
    expect(result).toEqual({ Different: 'NewValue', Missing: 42 });
    expect('Same' in result).toBe(false);
  });
});
