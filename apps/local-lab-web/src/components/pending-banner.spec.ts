import { describe, expect, it } from 'vitest';

import { applyDisabled } from './pending-banner';

describe('applyDisabled (Apply gating)', () => {
  it('disables Apply while an apply is running', () => {
    expect(applyDisabled(true, false)).toBe(true);
  });
  it('disables Apply while the form is dirty (unsaved edits) — mirrors Rebuild', () => {
    expect(applyDisabled(false, true)).toBe(true);
  });
  it('enables Apply only when idle and clean', () => {
    expect(applyDisabled(false, false)).toBe(false);
  });
});
