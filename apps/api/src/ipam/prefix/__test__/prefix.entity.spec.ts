import { IpamPrefix } from '@repo/api-client';
import { describe, expect, it } from 'vitest';
import { PrefixEntity } from '../prefix.entity';

function makePrefix(overrides?: Partial<IpamPrefix>): IpamPrefix {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    prefix: '10.0.0.0/24',
    status: 'ACTIVE',
    isPool: false,
    role: null,
    zoneId: null,
    organizationId: '22222222-2222-2222-2222-222222222222',
    vrfId: '33333333-3333-3333-3333-333333333333',
    parentId: null,
    vlanId: null,
    gatewayIpId: null,
    vrrpVipId: null,
    prefixRoleId: null,
    enableVlanTag: false,
    bondParameters: null,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    deletedAt: null,
    ...overrides,
  };
}

describe('PrefixEntity', () => {
  it('builds default create state', () => {
    const entity = PrefixEntity.create(
      { prefix: '192.168.1.0/24' },
      '44444444-4444-4444-4444-444444444444',
      '192.168.1.0/24',
    );

    expect(entity.state.prefix).toBe('192.168.1.0/24');
    expect(entity.state.status).toBe('ACTIVE');
    expect(entity.state.isPool).toBe(false);
    expect(entity.state.organizationId).toBe('44444444-4444-4444-4444-444444444444');
    expect(entity.state.vrfId).toBeNull();
    expect(entity.state.parentId).toBeNull();
    expect(entity.state.vlanId).toBeNull();
    expect(entity.state.gatewayIpId).toBeNull();
    expect(entity.isNew).toBe(true);
    expect(entity.isArchived).toBe(false);
  });

  it('no-op update does not flag any changes', () => {
    const before = makePrefix();
    const entity = PrefixEntity.restore(before);
    entity.applyUpdate({});

    expect(entity.changes.status).toBe(false);
    expect(entity.changes.isPool).toBe(false);
    expect(entity.changes.vrfId).toBe(false);
    expect(entity.changes.parentId).toBe(false);
    expect(entity.changes.vlanId).toBe(false);
    expect(entity.changes.gatewayIpId).toBe(false);
    expect(entity.shouldValidateVrf).toBe(false);
    expect(entity.shouldValidateParent).toBe(false);
    expect(entity.shouldValidateVlanCompatibility).toBe(false);
    expect(entity.shouldValidateGateway).toBe(false);
    expect(entity.state.prefix).toBe(before.prefix);
  });

  it('restore does not mutate the caller-owned snapshot on applyUpdate (audit before/after must diverge)', () => {
    const before = makePrefix({ status: 'ACTIVE' });
    const entity = PrefixEntity.restore(before);
    entity.applyUpdate({ status: 'RESERVED' });

    expect(entity.state.status).toBe('RESERVED');
    expect(before.status).toBe('ACTIVE');
  });

  it('restore does not mutate the caller-owned snapshot on setVrrpVip/clearVrrpVip', () => {
    const before = makePrefix({ vrrpVipId: null });
    const entity = PrefixEntity.restore(before);
    entity.setVrrpVip('77777777-7777-7777-7777-777777777777');

    expect(entity.state.vrrpVipId).toBe('77777777-7777-7777-7777-777777777777');
    expect(before.vrrpVipId).toBeNull();
  });

  it('partial update: status only', () => {
    const entity = PrefixEntity.restore(makePrefix());
    entity.applyUpdate({ status: 'RESERVED' });

    expect(entity.changes.status).toBe(true);
    expect(entity.changes.isPool).toBe(false);
    expect(entity.state.status).toBe('RESERVED');
    expect(entity.shouldValidateVrf).toBe(false);
    expect(entity.shouldValidateParent).toBe(false);
  });

  it('vrfId is diffed by value: force-writing the unchanged VRF records no change (skips ensureVrf)', () => {
    const current = '33333333-3333-3333-3333-333333333333';
    const entity = PrefixEntity.restore(makePrefix({ vrfId: current }));
    entity.applyUpdate({ vrfId: current });

    expect(entity.changes.vrfId).toBe(false);
    expect(entity.shouldValidateVrf).toBe(false);
  });

  it('vrfId changed to a new value records a change and requires validation', () => {
    const entity = PrefixEntity.restore(makePrefix({ vrfId: '33333333-3333-3333-3333-333333333333' }));
    entity.applyUpdate({ vrfId: '44444444-4444-4444-4444-444444444444' });

    expect(entity.changes.vrfId).toBe(true);
    expect(entity.shouldValidateVrf).toBe(true);
    expect(entity.state.vrfId).toBe('44444444-4444-4444-4444-444444444444');
  });

  it('partial update: isPool only', () => {
    const entity = PrefixEntity.restore(makePrefix());
    entity.applyUpdate({ isPool: true });

    expect(entity.changes.isPool).toBe(true);
    expect(entity.state.isPool).toBe(true);
    expect(entity.shouldValidateParent).toBe(false);
  });

  it('partial update: vrfId triggers vrf, parent, vlan, and gateway validation', () => {
    const entity = PrefixEntity.restore(makePrefix({ vrfId: null }));
    entity.applyUpdate({ vrfId: '55555555-5555-5555-5555-555555555555' });

    expect(entity.changes.vrfId).toBe(true);
    expect(entity.state.vrfId).toBe('55555555-5555-5555-5555-555555555555');
    expect(entity.shouldValidateVrf).toBe(true);
    expect(entity.shouldValidateParent).toBe(true);
    expect(entity.shouldValidateVlanCompatibility).toBe(true);
    expect(entity.shouldValidateGateway).toBe(true);
  });

  it('partial update: parentId triggers parent validation', () => {
    const entity = PrefixEntity.restore(makePrefix());
    entity.applyUpdate({ parentId: '66666666-6666-6666-6666-666666666666' });

    expect(entity.changes.parentId).toBe(true);
    expect(entity.state.parentId).toBe('66666666-6666-6666-6666-666666666666');
    expect(entity.shouldValidateParent).toBe(true);
    expect(entity.shouldValidateVrf).toBe(false);
  });

  it('partial update: vlanId triggers vlan compatibility validation', () => {
    const entity = PrefixEntity.restore(makePrefix());
    entity.applyUpdate({ vlanId: '77777777-7777-7777-7777-777777777777' });

    expect(entity.changes.vlanId).toBe(true);
    expect(entity.state.vlanId).toBe('77777777-7777-7777-7777-777777777777');
    expect(entity.shouldValidateVlanCompatibility).toBe(true);
  });

  it('partial update: gatewayIpId triggers gateway validation', () => {
    const entity = PrefixEntity.restore(makePrefix());
    entity.applyUpdate({ gatewayIpId: '88888888-8888-8888-8888-888888888888' });

    expect(entity.changes.gatewayIpId).toBe(true);
    expect(entity.state.gatewayIpId).toBe('88888888-8888-8888-8888-888888888888');
    expect(entity.shouldValidateGateway).toBe(true);
  });

  it('partial update: zoneId tracks change (set and clear)', () => {
    const entity = PrefixEntity.restore(makePrefix({ zoneId: null }));
    entity.applyUpdate({ zoneId: '99999999-9999-9999-9999-999999999999' });
    expect(entity.changes.zoneId).toBe(true);
    expect(entity.state.zoneId).toBe('99999999-9999-9999-9999-999999999999');

    const cleared = PrefixEntity.restore(makePrefix({ zoneId: '99999999-9999-9999-9999-999999999999' }));
    cleared.applyUpdate({ zoneId: null });
    expect(cleared.changes.zoneId).toBe(true);
    expect(cleared.state.zoneId).toBeNull();
  });

  it('create carries zoneId from input', () => {
    const entity = PrefixEntity.create(
      { prefix: '10.0.0.0/24', zoneId: '99999999-9999-9999-9999-999999999999' },
      'org-1',
      '10.0.0.0/24',
    );
    expect(entity.state.zoneId).toBe('99999999-9999-9999-9999-999999999999');
  });

  it('archive marks entity as archived', () => {
    const entity = PrefixEntity.restore(makePrefix());
    expect(entity.isArchived).toBe(false);
    entity.archive();
    expect(entity.isArchived).toBe(true);
  });

  it('shouldValidateVrf is false when vrfId is set to null', () => {
    const entity = PrefixEntity.restore(makePrefix({ vrfId: '33333333-3333-3333-3333-333333333333' }));
    entity.applyUpdate({ vrfId: null });

    expect(entity.changes.vrfId).toBe(true);
    expect(entity.state.vrfId).toBeNull();
    expect(entity.shouldValidateVrf).toBe(false);
  });

  it('shouldValidateVrf is false on create when vrfId is omitted', () => {
    const entity = PrefixEntity.create({ prefix: '10.0.0.0/8' }, 'org-1', '10.0.0.0/8');

    expect(entity.state.vrfId).toBeNull();
    expect(entity.shouldValidateVrf).toBe(false);
  });

  it('shouldValidateVrf is true on create when vrfId is provided', () => {
    const entity = PrefixEntity.create(
      { prefix: '10.0.0.0/8', vrfId: '33333333-3333-3333-3333-333333333333' },
      'org-1',
      '10.0.0.0/8',
    );

    expect(entity.shouldValidateVrf).toBe(true);
  });

  it('setGateway and clearGateway track changes', () => {
    const entity = PrefixEntity.restore(makePrefix());

    entity.setGateway('99999999-9999-9999-9999-999999999999');
    expect(entity.changes.gatewayIpId).toBe(true);
    expect(entity.state.gatewayIpId).toBe('99999999-9999-9999-9999-999999999999');

    entity.clearGateway();
    expect(entity.state.gatewayIpId).toBeNull();
    expect(entity.changes.gatewayIpId).toBe(true);
  });

  it('setVrrpVip and clearVrrpVip track changes', () => {
    const entity = PrefixEntity.restore(makePrefix());

    entity.setVrrpVip('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(entity.changes.vrrpVipId).toBe(true);
    expect(entity.state.vrrpVipId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

    entity.clearVrrpVip();
    expect(entity.state.vrrpVipId).toBeNull();
    expect(entity.changes.vrrpVipId).toBe(true);
  });

  it('prefixRoleId is diffed by value: force-writing the unchanged role records no change (skips ensurePrefixRole)', () => {
    const current = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const entity = PrefixEntity.restore(makePrefix({ prefixRoleId: current }));
    entity.applyUpdate({ prefixRoleId: current });

    expect(entity.changes.prefixRoleId).toBe(false);
    expect(entity.shouldValidatePrefixRole).toBe(false);
  });

  it('prefixRoleId changed to a new value records a change and requires validation', () => {
    const entity = PrefixEntity.restore(makePrefix({ prefixRoleId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }));
    entity.applyUpdate({ prefixRoleId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });

    expect(entity.changes.prefixRoleId).toBe(true);
    expect(entity.shouldValidatePrefixRole).toBe(true);
    expect(entity.state.prefixRoleId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  });

  it('create respects explicit status and isPool overrides', () => {
    const entity = PrefixEntity.create(
      { prefix: '172.16.0.0/12', status: 'CONTAINER', isPool: true },
      'org-1',
      '172.16.0.0/12',
    );

    expect(entity.state.status).toBe('CONTAINER');
    expect(entity.state.isPool).toBe(true);
  });
});
