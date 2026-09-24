import { describe, expect, it } from 'vitest';

import { contributionAllowed } from '../contribution-permission';

describe('contributionAllowed', () => {
  const can = (resource: string, action: string) => resource === 'billing' && action === 'read';

  it('allows contributions with no required permission', () => {
    expect(contributionAllowed(undefined, can, false)).toBe(true);
  });

  it('shows unrestricted contributions even while permissions are loading', () => {
    expect(contributionAllowed(undefined, can, true)).toBe(true);
  });

  it('hides gated contributions while permissions are loading', () => {
    expect(contributionAllowed({ resource: 'billing', action: 'read' }, can, true)).toBe(false);
  });

  it('shows gated contributions the member can perform', () => {
    expect(contributionAllowed({ resource: 'billing', action: 'read' }, can, false)).toBe(true);
  });

  it('hides gated contributions the member cannot perform', () => {
    expect(contributionAllowed({ resource: 'billing', action: 'update' }, can, false)).toBe(false);
  });
});
