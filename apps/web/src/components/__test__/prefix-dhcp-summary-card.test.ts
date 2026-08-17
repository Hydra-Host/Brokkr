import { describe, expect, it } from 'vitest';

import { modeBadgeVariant } from '../prefix-dhcp-summary-card';

describe('modeBadgeVariant', () => {
  it('returns success for AUTHORITATIVE', () => {
    expect(modeBadgeVariant('AUTHORITATIVE')).toBe('success');
  });

  it('returns info for PROXY', () => {
    expect(modeBadgeVariant('PROXY')).toBe('info');
  });

  it('returns outline for OFF', () => {
    expect(modeBadgeVariant('OFF')).toBe('outline');
  });
});
