import { describe, expect, it } from 'vitest';

import { NOOP_PXE_OBSERVER, PXE_DECISION_TTL_SECONDS } from '../pxe-decision.js';

describe('pxe-decision', () => {
  it('the no-op observer accepts every decision without effect', () => {
    expect(NOOP_PXE_OBSERVER.onDecision('aa:bb:cc:dd:ee:ff', 'offered')).toBeUndefined();
    expect(NOOP_PXE_OBSERVER.onDecision('aa:bb:cc:dd:ee:ff', 'refused-allowlist')).toBeUndefined();
    expect(NOOP_PXE_OBSERVER.onDecision('aa:bb:cc:dd:ee:ff', 'no-subnet')).toBeUndefined();
  });

  it('keeps a decision for seven days', () => {
    expect(PXE_DECISION_TTL_SECONDS).toBe(604_800);
  });
});
