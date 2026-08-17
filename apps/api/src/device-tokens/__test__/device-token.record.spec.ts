import { ActiveRecordRegistry } from '@repo/active-record';
import { DeviceTokenContext, DeviceTokenRevocationReason, DeviceTokenStatus } from '@repo/database';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceTokenRecord } from '../device-token.record';

function persistedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'token-1',
    deviceId: 'device-1',
    deploymentId: null,
    context: DeviceTokenContext.BROKKR_LIVE,
    tokenHash: 'hash',
    displayId: 'display',
    status: DeviceTokenStatus.ACTIVE,
    rotationGeneration: 2,
    expiresAt: null,
    lastUsedAt: null,
    lastUsedIp: null,
    revokedAt: null,
    revokedReason: null,
    revokedNote: null,
    issuedBy: 'system',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('DeviceTokenRecord.revoke', () => {
  beforeEach(() => {
    ActiveRecordRegistry.configureForTest({ deviceToken: { update: vi.fn(), create: vi.fn() } }, null);
  });

  afterEach(() => vi.clearAllMocks());

  it('marks the record revoked, increments rotationGeneration, and records reason/note', () => {
    const record = DeviceTokenRecord.fromRow(persistedRow({ rotationGeneration: 2 }));

    record.revoke(DeviceTokenRevocationReason.ROTATION, 'rotated by device');

    expect(record.data.status).toBe(DeviceTokenStatus.REVOKED);
    expect(record.data.rotationGeneration).toBe(3);
    expect(record.data.revokedReason).toBe(DeviceTokenRevocationReason.ROTATION);
    expect(record.data.revokedNote).toBe('rotated by device');
    expect(record.data.revokedAt).toBeInstanceOf(Date);
    expect(record.isDirty).toBe(true);
  });

  it('defaults revokedNote to null when no note is supplied', () => {
    const record = DeviceTokenRecord.fromRow(persistedRow());
    record.revoke(DeviceTokenRevocationReason.MANUAL);
    expect(record.data.revokedNote).toBeNull();
  });

  it('short-circuits when the record is already revoked (idempotent re-revoke)', () => {
    const revokedAt = new Date('2026-05-01T00:00:00Z');
    const record = DeviceTokenRecord.fromRow(
      persistedRow({
        status: DeviceTokenStatus.REVOKED,
        rotationGeneration: 5,
        revokedAt,
        revokedReason: DeviceTokenRevocationReason.ROTATION,
        revokedNote: 'first revoke',
      }),
    );

    record.revoke(DeviceTokenRevocationReason.MANUAL, 'second revoke');

    expect(record.data.rotationGeneration).toBe(5);
    expect(record.data.revokedReason).toBe(DeviceTokenRevocationReason.ROTATION);
    expect(record.data.revokedNote).toBe('first revoke');
    expect(record.data.revokedAt).toEqual(revokedAt);
    expect(record.isDirty).toBe(false);
  });
});
