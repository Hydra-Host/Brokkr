import type { FleetPending } from '@repo/local-lab-contract';
import { describe, expect, it } from 'vitest';

import { pendingChangeCount, saveToastMessage } from './pending';

const base: FleetPending = {
  inSync: false,
  severity: 'hot-appliable',
  desiredDigest: 'd',
  appliedDigest: null,
  appliedAt: null,
  summary: { added: 0, removed: 0, changed: 0, unchanged: 0 },
  nodes: { added: [], removed: [], changed: [] },
  network: { changed: false, fields: [] },
  note: null,
};

describe('pendingChangeCount', () => {
  it('counts node drift + one for network drift', () => {
    expect(pendingChangeCount({ ...base, summary: { added: 2, removed: 1, changed: 0, unchanged: 0 } })).toBe(3);
    expect(pendingChangeCount({ ...base, network: { changed: true, fields: ['cidr'] } })).toBe(1);
  });
  it('does NOT count planes-change (stays count-only so the banner headline cannot double-count)', () => {
    expect(pendingChangeCount({ ...base, severity: 'planes-change' })).toBe(0);
  });
});

describe('saveToastMessage', () => {
  it('shows a dedicated planes-change line for a pure plane flip (zero counts, null note)', () => {
    expect(saveToastMessage({ ...base, severity: 'planes-change' })).toBe(
      'Saved — fleet planes changed, not yet applied. Apply to take effect.',
    );
  });
  it('surfaces the note on degraded drift', () => {
    expect(saveToastMessage({ ...base, severity: 'needs-full-rebuild', note: 'drift check failed' })).toBe(
      'Saved — drift check failed',
    );
  });
  it('shows the change count for ordinary drift', () => {
    expect(saveToastMessage({ ...base, summary: { added: 1, removed: 0, changed: 0, unchanged: 0 } })).toBe(
      'Saved — 1 change pending. Apply to take effect.',
    );
  });
  it('shows plain Saved when in sync', () => {
    expect(saveToastMessage({ ...base, inSync: true })).toBe('Saved');
    expect(saveToastMessage(null)).toBe('Saved');
  });
});
