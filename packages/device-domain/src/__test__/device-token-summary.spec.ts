import { DeviceTokenContext, DeviceTokenStatus } from '@repo/database';
import { describe, expect, it } from 'vitest';
import { DEVICE_TOKEN_SUMMARY_SELECT, deviceTokenSummary } from '../device-token-summary';

const row = {
  id: 't-1',
  deviceId: '22222222-2222-2222-2222-222222222222',
  deploymentId: null,
  context: DeviceTokenContext.BROKKR_LIVE,
  displayId: 'ab12',
  status: DeviceTokenStatus.ACTIVE,
  rotationGeneration: 0,
  expiresAt: null,
  lastUsedAt: new Date('2026-09-16T11:57:00.000Z'),
  lastUsedIp: '10.40.1.23',
  revokedAt: null,
  revokedReason: null,
  revokedNote: 'internal note',
  issuedBy: 'user:1',
  createdAt: new Date('2026-09-15T10:00:00.000Z'),
  updatedAt: new Date('2026-09-16T11:57:00.000Z'),
};

describe('deviceTokenSummary', () => {
  it('keeps exactly the selected columns and drops the operator-only fields', () => {
    const out = deviceTokenSummary(row);
    expect(Object.keys(out).sort()).toEqual(Object.keys(DEVICE_TOKEN_SUMMARY_SELECT).sort());
    expect(out).toMatchObject({
      id: 't-1',
      context: 'BROKKR_LIVE',
      status: 'ACTIVE',
      lastUsedAt: new Date('2026-09-16T11:57:00.000Z'),
      lastUsedIp: '10.40.1.23',
    });
    expect(out).not.toHaveProperty('revokedNote');
    expect(out).not.toHaveProperty('issuedBy');
  });
});
