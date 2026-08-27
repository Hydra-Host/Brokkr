import { describe, expect, it } from 'vitest';

import { applyClassFor } from './apply-class';
import { unclassifiedWritableKnobs, writableFor } from './writable';

describe('writableFor', () => {
  it('lets the slot through even though the catalog declares it non-editable', () => {
    expect(writableFor('stack.slot', false)).toBe(true);
  });

  it('refuses the retired counts, which nothing consumes', () => {
    expect(writableFor('stackCounts.spoke', true)).toBe(false);
    expect(writableFor('stackCounts.hub', true)).toBe(false);
  });

  it('otherwise follows the catalog', () => {
    expect(writableFor('zoneCrypto.bridgeAtRestKey', true)).toBe(true);
    expect(writableFor('ports.grafana', false)).toBe(false);
  });
});

describe('the classifier and the writer agree on what a path costs', () => {
  it('reads a retired counts path as inert, matching its refusal to write', () => {
    expect(applyClassFor('stackCounts.spoke')).toBe('inert');
    expect(writableFor('stackCounts.spoke', true)).toBe(false);
  });
});

describe('unclassifiedWritableKnobs', () => {
  it('names a writable knob no rule prices', () => {
    expect(unclassifiedWritableKnobs([{ path: 'remoteInfra.enable', editable: true }])).toEqual(['remoteInfra.enable']);
  });

  it('passes a knob whose namespace a rule owns', () => {
    expect(unclassifiedWritableKnobs([{ path: 'ports.postgres', editable: true }])).toEqual([]);
  });

  it('ignores an unpriced knob no save can reach', () => {
    expect(
      unclassifiedWritableKnobs([
        { path: 'zoneCrypto.hubPrivateKey', editable: false },
        { path: 'polyrepo.hub.path', editable: false },
      ]),
    ).toEqual([]);
  });

  it('follows writableFor rather than editable, so the slot is judged as the writer sees it', () => {
    expect(unclassifiedWritableKnobs([{ path: 'stack.slot', editable: false }])).toEqual([]);
    expect(unclassifiedWritableKnobs([{ path: 'stackCounts.spoke', editable: true }])).toEqual([]);
  });
});
