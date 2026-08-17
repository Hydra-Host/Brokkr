import { IpAddress } from '@repo/api-client';
import { describe, expect, it } from 'vitest';
import { IpAddressEntity } from '../ip-address.entity';

function makeIpAddress(overrides?: Partial<IpAddress>): IpAddress {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    address: '10.0.0.10',
    status: 'ACTIVE',
    dnsName: 'host.local',
    organizationId: '22222222-2222-2222-2222-222222222222',
    vrfId: '33333333-3333-3333-3333-333333333333',
    assignedObjectType: null,
    assignedObjectId: null,
    interfaceId: null,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

describe('IpAddressEntity', () => {
  it('builds default create state', () => {
    const entity = IpAddressEntity.create(
      {
        address: '10.0.0.10',
      },
      '44444444-4444-4444-4444-444444444444',
      '10.0.0.10',
    );

    expect(entity.state.address).toBe('10.0.0.10');
    expect(entity.state.status).toBe('ACTIVE');
    expect(entity.state.dnsName).toBeNull();
    expect(entity.state.vrfId).toBeNull();
    expect(entity.shouldCheckAddressUniqueness).toBe(true);
  });

  it('tracks update change-set and uniqueness conditions', () => {
    const before = makeIpAddress();
    const entity = IpAddressEntity.restore(before);
    entity.applyUpdate({ vrfId: null, dnsName: null });

    expect(entity.changes.vrfId).toBe(true);
    expect(entity.changes.dnsName).toBe(true);
    expect(entity.state.vrfId).toBeNull();
    expect(entity.shouldValidateVrf).toBe(false);
    expect(entity.shouldCheckAddressUniqueness).toBe(true);
  });

  it('tracks interfaceId assignment and dual-writes the polymorphic assignment in lockstep', () => {
    const entity = IpAddressEntity.restore(makeIpAddress());
    entity.applyUpdate({ interfaceId: '55555555-5555-5555-5555-555555555555' });

    expect(entity.changes.interfaceId).toBe(true);
    expect(entity.state.interfaceId).toBe('55555555-5555-5555-5555-555555555555');
    expect(entity.state.assignedObjectType).toBe('Interface');
    expect(entity.state.assignedObjectId).toBe('55555555-5555-5555-5555-555555555555');
  });

  it('tracks interfaceId cleared to null and clears the polymorphic assignment too', () => {
    const entity = IpAddressEntity.restore(makeIpAddress({ interfaceId: '55555555-5555-5555-5555-555555555555' }));
    entity.applyUpdate({ interfaceId: null });

    expect(entity.changes.interfaceId).toBe(true);
    expect(entity.state.interfaceId).toBeNull();
    expect(entity.state.assignedObjectType).toBeNull();
    expect(entity.state.assignedObjectId).toBeNull();
  });

  it('create dual-writes the polymorphic assignment when an interfaceId is supplied', () => {
    const assigned = IpAddressEntity.create(
      { address: '10.0.0.5', interfaceId: '55555555-5555-5555-5555-555555555555' } as never,
      'org-1',
      '10.0.0.5',
    );
    expect(assigned.state.assignedObjectType).toBe('Interface');
    expect(assigned.state.assignedObjectId).toBe('55555555-5555-5555-5555-555555555555');

    const unassigned = IpAddressEntity.create({ address: '10.0.0.6' } as never, 'org-1', '10.0.0.6');
    expect(unassigned.state.assignedObjectType).toBeNull();
    expect(unassigned.state.assignedObjectId).toBeNull();
  });

  it('does not flag interfaceId when omitted from update', () => {
    const entity = IpAddressEntity.restore(makeIpAddress());
    entity.applyUpdate({ dnsName: 'changed.local' });

    expect(entity.changes.interfaceId).toBe(false);
    expect(entity.state.interfaceId).toBeNull();
  });

  it('restore does not mutate the caller-owned snapshot on applyUpdate (audit before/after must diverge)', () => {
    const before = makeIpAddress({ vrfId: '33333333-3333-3333-3333-333333333333' });
    const entity = IpAddressEntity.restore(before);
    entity.applyUpdate({ vrfId: null });

    expect(entity.state.vrfId).toBeNull();
    expect(before.vrfId).toBe('33333333-3333-3333-3333-333333333333');
  });
});
