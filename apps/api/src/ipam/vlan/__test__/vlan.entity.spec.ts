import { Vlan } from '@repo/api-client';
import { describe, expect, it } from 'vitest';
import { VlanEntity } from '../vlan.entity';

function makeVlan(overrides?: Partial<Vlan>): Vlan {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'prod',
    vid: 100,
    description: 'desc',
    status: 'ACTIVE',
    organizationId: '22222222-2222-2222-2222-222222222222',
    vrfId: '33333333-3333-3333-3333-333333333333',
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

describe('VlanEntity', () => {
  it('builds default create state', () => {
    const entity = VlanEntity.create(
      {
        name: 'core',
        vid: 200,
      },
      '44444444-4444-4444-4444-444444444444',
    );

    expect(entity.state.name).toBe('core');
    expect(entity.state.vid).toBe(200);
    expect(entity.state.description).toBeNull();
    expect(entity.state.status).toBe('ACTIVE');
    expect(entity.state.vrfId).toBeNull();
    expect(entity.state.organizationId).toBe('44444444-4444-4444-4444-444444444444');
    expect(entity.shouldValidateVrf).toBe(false);
    expect(entity.shouldCheckUniqueness).toBe(true);
    expect(entity.uniquenessProbe.name).toBe('core');
    expect(entity.uniquenessProbe.vid).toBe(200);
  });

  it('handles no-op update input', () => {
    const before = makeVlan();
    const entity = VlanEntity.restore(before);
    entity.applyUpdate({});

    expect(entity.shouldCheckUniqueness).toBe(false);
    expect(entity.changes.name).toBe(false);
    expect(entity.changes.vid).toBe(false);
    expect(entity.changes.description).toBe(false);
    expect(entity.changes.status).toBe(false);
    expect(entity.changes.vrfId).toBe(false);
    expect(entity.state.name).toBe(before.name);
    expect(entity.state.vid).toBe(before.vid);
    expect(entity.state.description).toBe(before.description);
    expect(entity.state.status).toBe(before.status);
    expect(entity.state.vrfId).toBe(before.vrfId);
  });

  it('handles partial update for name only', () => {
    const before = makeVlan();
    const entity = VlanEntity.restore(before);
    entity.applyUpdate({ name: 'prod-renamed' });

    expect(entity.changes.name).toBe(true);
    expect(entity.shouldCheckUniqueness).toBe(true);
    expect(entity.state.name).toBe('prod-renamed');
    expect(entity.state.vid).toBe(before.vid);
    expect(entity.state.vrfId).toBe(before.vrfId);
    expect(entity.uniquenessProbe.name).toBe('prod-renamed');
    expect(entity.uniquenessProbe.vid).toBeNull();
  });

  it('distinguishes vrf null from undefined', () => {
    const before = makeVlan();
    const undefinedEntity = VlanEntity.restore(before);
    undefinedEntity.applyUpdate({});
    const nullEntity = VlanEntity.restore(before);
    nullEntity.applyUpdate({ vrfId: null });

    expect(undefinedEntity.changes.vrfId).toBe(false);
    expect(undefinedEntity.state.vrfId).toBe(before.vrfId);
    expect(undefinedEntity.shouldCheckUniqueness).toBe(false);

    expect(nullEntity.changes.vrfId).toBe(true);
    expect(nullEntity.state.vrfId).toBeNull();
    expect(nullEntity.shouldCheckUniqueness).toBe(true);
    expect(nullEntity.uniquenessProbe.name).toBe(before.name);
    expect(nullEntity.uniquenessProbe.vid).toBe(before.vid);
  });

  it('marks entity as archived', () => {
    const entity = VlanEntity.restore(makeVlan());
    entity.archive();
    expect(entity.isArchived).toBe(true);
  });
});
