import { JobType, LifecycleJobPhase } from '@repo/database/enums';
import { describe, expect, it } from 'vitest';
import { LifecycleJobKindSchema, LifecycleJobPhaseSchema } from '../jobs';

describe('LifecycleJobKindSchema', () => {
  it('derives its options from the prisma JobType enum', () => {
    expect([...LifecycleJobKindSchema.options].sort()).toEqual(Object.values(JobType).sort());
  });
});

describe('LifecycleJobPhaseSchema', () => {
  it('derives its options from the prisma LifecycleJobPhase enum', () => {
    expect([...LifecycleJobPhaseSchema.options].sort()).toEqual(
      Object.values(LifecycleJobPhase).sort(),
    );
  });
});
