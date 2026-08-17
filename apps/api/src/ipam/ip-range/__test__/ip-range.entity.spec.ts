import { IpRange } from '@repo/api-client';
import { describe, expect, it } from 'vitest';
import { IpRangeEntity } from '../ip-range.entity';

function makeIpRange(overrides?: Partial<IpRange>): IpRange {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    start: '10.0.0.10',
    end: '10.0.0.20',
    status: 'ACTIVE',
    purpose: 'pool',
    organizationId: '22222222-2222-2222-2222-222222222222',
    prefixId: '33333333-3333-3333-3333-333333333333',
    vrfId: null,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

describe('IpRangeEntity', () => {
  it('builds default create state', () => {
    const entity = IpRangeEntity.create(
      {
        prefixId: '33333333-3333-3333-3333-333333333333',
        start: '10.0.0.10',
        end: '10.0.0.20',
      },
      '44444444-4444-4444-4444-444444444444',
      '55555555-5555-5555-5555-555555555555',
    );

    expect(entity.state.status).toBe('ACTIVE');
    expect(entity.state.purpose).toBeNull();
    expect(entity.state.vrfId).toBe('55555555-5555-5555-5555-555555555555');
    expect(entity.shouldNormalizeBounds).toBe(true);
    expect(entity.shouldValidatePlacement).toBe(true);
  });

  it('tracks updates and validation flags', () => {
    const entity = IpRangeEntity.restore(makeIpRange());
    entity.applyUpdate({
      start: '10.0.0.30',
      purpose: null,
    });

    expect(entity.changes.start).toBe(true);
    expect(entity.changes.purpose).toBe(true);
    expect(entity.shouldNormalizeBounds).toBe(true);
    expect(entity.shouldValidatePlacement).toBe(true);
  });

  it('archives restored entity', () => {
    const entity = IpRangeEntity.restore(makeIpRange());
    entity.archive();

    expect(entity.isArchived).toBe(true);
  });
});
