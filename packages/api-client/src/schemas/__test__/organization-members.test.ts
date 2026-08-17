import { describe, expect, it } from 'vitest';
import { OrganizationMembersQuerySchema } from '../organization-members';

describe('OrganizationMembersQuerySchema', () => {
  it.each([
    [true, true],
    [false, false],
    ['true', true],
    ['false', false],
  ])('parses ownerTransferEligible %j as %s', (input, expected) => {
    expect(OrganizationMembersQuerySchema.parse({ ownerTransferEligible: input }).ownerTransferEligible).toBe(expected);
  });

  it('allows ownerTransferEligible to be omitted', () => {
    expect(OrganizationMembersQuerySchema.parse({}).ownerTransferEligible).toBeUndefined();
  });

  it.each(['yes', 'False', '', '2'])('rejects invalid ownerTransferEligible value %j', (ownerTransferEligible) => {
    expect(OrganizationMembersQuerySchema.safeParse({ ownerTransferEligible }).success).toBe(false);
  });
});
