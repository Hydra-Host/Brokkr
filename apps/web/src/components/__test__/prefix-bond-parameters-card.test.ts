import { describe, expect, it } from 'vitest';

import { apiToForm, formToPayload } from '../prefix-bond-parameters-card';

describe('apiToForm', () => {
  it('maps a stored bond map to editable rows', () => {
    expect(apiToForm({ mode: '802.3ad', 'lacp-rate': 'fast' })).toEqual({
      parameters: [
        { key: 'mode', value: '802.3ad' },
        { key: 'lacp-rate', value: 'fast' },
      ],
    });
  });

  it('shows no rows for an unbonded prefix', () => {
    expect(apiToForm(null)).toEqual({ parameters: [] });
  });

  it('stringifies non-string scalars so a number stays editable as text', () => {
    // the API accepts string | number | boolean; the form round-trips them all as text
    expect(apiToForm({ 'mii-monitor-interval': 100, 'all-slaves-active': true })).toEqual({
      parameters: [
        { key: 'mii-monitor-interval', value: '100' },
        { key: 'all-slaves-active', value: 'true' },
      ],
    });
  });

  it('joins an array value rather than rendering [object Object]', () => {
    expect(apiToForm({ 'arp-ip-targets': ['10.0.0.1', '10.0.0.2'] })).toEqual({
      parameters: [{ key: 'arp-ip-targets', value: '10.0.0.1, 10.0.0.2' }],
    });
  });
});

describe('formToPayload', () => {
  it('collapses rows back into the bond map', () => {
    expect(
      formToPayload(
        {
          parameters: [
            { key: 'mode', value: '802.3ad' },
            { key: 'transmit-hash-policy', value: 'layer3+4' },
          ],
        },
        null,
      ),
    ).toEqual({ mode: '802.3ad', 'transmit-hash-policy': 'layer3+4' });
  });

  // BondParametersSchema refuses an empty object — bonding is disabled with null, and
  // sending {} would 400 instead of clearing.
  it('sends null when every row is removed, so bonding is actually disabled', () => {
    expect(formToPayload({ parameters: [] }, null)).toBeNull();
  });

  it('trims surrounding whitespace so a padded key cannot reach the YAML renderer', () => {
    expect(formToPayload({ parameters: [{ key: '  mode  ', value: '  802.3ad  ' }] }, null)).toEqual({
      mode: '802.3ad',
    });
  });

  // netplan wants a sequence for keys like arp-ip-targets. Saving the comma text the editor shows
  // back as a plain string would change the stored type and emit a quoted scalar instead.
  it('restores an array for a key the prefix already stored as one', () => {
    expect(
      formToPayload(
        { parameters: [{ key: 'arp-ip-targets', value: '10.0.0.1, 10.0.0.2' }] },
        {
          'arp-ip-targets': ['10.0.0.1', '10.0.0.2'],
        },
      ),
    ).toEqual({ 'arp-ip-targets': ['10.0.0.1', '10.0.0.2'] });
  });

  it('keeps a single remaining entry an array, so the stored type does not flip', () => {
    expect(
      formToPayload(
        { parameters: [{ key: 'arp-ip-targets', value: '10.0.0.1' }] },
        {
          'arp-ip-targets': ['10.0.0.1', '10.0.0.2'],
        },
      ),
    ).toEqual({ 'arp-ip-targets': ['10.0.0.1'] });
  });

  it('leaves a string key alone even when the value contains a comma', () => {
    expect(formToPayload({ parameters: [{ key: 'mode', value: 'a,b' }] }, { mode: 'a,b' })).toEqual({ mode: 'a,b' });
  });
});

// The round trip the review flagged: read the stored map, hand it to the editor, save it back
// untouched. Anything lossy here silently rewrites the prefix on an unrelated edit.
describe('apiToForm -> formToPayload round trip', () => {
  for (const stored of [
    { mode: '802.3ad', 'lacp-rate': 'fast' },
    { 'mii-monitor-interval': 100 },
    { 'arp-ip-targets': ['10.0.0.1', '10.0.0.2'] },
    { mode: '802.3ad', 'arp-ip-targets': ['10.0.0.1'] },
  ]) {
    it(`preserves ${JSON.stringify(stored)}`, () => {
      const payload = formToPayload(apiToForm(stored), stored);
      // numbers come back as their text form; the API accepts both and the renderer re-coerces
      const expected = Object.fromEntries(
        Object.entries(stored).map(([k, v]) => [k, Array.isArray(v) ? v : String(v)]),
      );
      expect(payload).toEqual(expected);
    });
  }
});
