import { describe, expect, it } from 'vitest';

import { getOwnerManagementAvailability } from '../owner-management';

const readyInput = {
  isLoading: false,
  loadFailed: false,
  isOwnerCapableActor: true,
  hasOwnerCapableRole: true,
};

describe('getOwnerManagementAvailability', () => {
  it('waits for roles, permissions, and owner candidates', () => {
    expect(getOwnerManagementAvailability({ ...readyInput, isLoading: true })).toEqual({
      state: 'loading',
      message: 'Loading owner controls…',
    });
  });

  it('explains when the actor is not owner-capable', () => {
    expect(getOwnerManagementAvailability({ ...readyInput, isOwnerCapableActor: false })).toEqual({
      state: 'unavailable',
      message: 'Only an organization owner can manage owner access.',
    });
  });

  it('explains when no owner-capable role exists', () => {
    expect(getOwnerManagementAvailability({ ...readyInput, hasOwnerCapableRole: false })).toEqual({
      state: 'unavailable',
      message: 'No owner-capable role is available.',
    });
  });

  it('enables owner management only when every prerequisite is ready', () => {
    expect(getOwnerManagementAvailability(readyInput)).toEqual({ state: 'ready' });
  });
});
