import { Vrf } from '@repo/api-client';
import { describe, expect, it } from 'vitest';
import { VrfEntity } from '../vrf.entity';

function makeVrf(overrides?: Partial<Vrf>): Vrf {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'prod',
    rd: '65000:1',
    description: 'default',
    organizationId: '22222222-2222-2222-2222-222222222222',
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

describe('VrfEntity', () => {
  it('builds default create state with name, rd, and description', () => {
    const entity = VrfEntity.create(
      { name: 'blue', rd: '65000:2', description: 'test vrf' },
      '33333333-3333-3333-3333-333333333333',
    );

    expect(entity.state.name).toBe('blue');
    expect(entity.state.rd).toBe('65000:2');
    expect(entity.state.description).toBe('test vrf');
    expect(entity.state.organizationId).toBe('33333333-3333-3333-3333-333333333333');
    expect(entity.isNew).toBe(true);
    expect(entity.isArchived).toBe(false);
    expect(entity.shouldCheckUniqueness).toBe(true);
    expect(entity.shouldValidateRd).toBe(true);
    expect(entity.uniquenessProbe.name).toBe('blue');
    expect(entity.uniquenessProbe.rd).toBe('65000:2');
  });

  it('defaults rd and description to null when omitted', () => {
    const entity = VrfEntity.create({ name: 'minimal' }, '33333333-3333-3333-3333-333333333333');

    expect(entity.state.rd).toBeNull();
    expect(entity.state.description).toBeNull();
  });

  it('no-op update does not flag any changes', () => {
    const before = makeVrf();
    const entity = VrfEntity.restore(before);
    entity.applyUpdate({});

    expect(entity.changes.name).toBe(false);
    expect(entity.changes.rd).toBe(false);
    expect(entity.changes.description).toBe(false);
    expect(entity.shouldCheckUniqueness).toBe(false);
    expect(entity.shouldValidateRd).toBe(false);
    expect(entity.state.name).toBe(before.name);
    expect(entity.state.rd).toBe(before.rd);
    expect(entity.state.description).toBe(before.description);
  });

  it('partial update (name only) flags correct change', () => {
    const before = makeVrf();
    const entity = VrfEntity.restore(before);
    entity.applyUpdate({ name: 'staging' });

    expect(entity.changes.name).toBe(true);
    expect(entity.changes.rd).toBe(false);
    expect(entity.changes.description).toBe(false);
    expect(entity.shouldCheckUniqueness).toBe(true);
    expect(entity.state.name).toBe('staging');
    expect(entity.state.rd).toBe(before.rd);
    expect(entity.uniquenessProbe.name).toBe('staging');
    expect(entity.uniquenessProbe.rd).toBeNull();
  });

  it('archive marks entity as archived', () => {
    const entity = VrfEntity.restore(makeVrf());
    expect(entity.isArchived).toBe(false);
    entity.archive();
    expect(entity.isArchived).toBe(true);
  });

  it('rd can be set to null via update', () => {
    const entity = VrfEntity.restore(makeVrf({ rd: '65000:1' }));
    entity.applyUpdate({ rd: null });

    expect(entity.changes.rd).toBe(true);
    expect(entity.state.rd).toBeNull();
    expect(entity.shouldValidateRd).toBe(true);
    expect(entity.shouldCheckUniqueness).toBe(true);
    expect(entity.uniquenessProbe.rd).toBeNull();
  });

  it('rd can be null from creation when omitted', () => {
    const entity = VrfEntity.create({ name: 'no-rd' }, '33333333-3333-3333-3333-333333333333');

    expect(entity.state.rd).toBeNull();
    expect(entity.shouldValidateRd).toBe(true);
    expect(entity.uniquenessProbe.rd).toBeNull();
  });
});
