import type { DeviceTokenSummary } from '@repo/api-client';
import type { Prisma } from '@repo/database';

export const DEVICE_TOKEN_SUMMARY_SELECT = {
  id: true,
  deviceId: true,
  context: true,
  displayId: true,
  status: true,
  rotationGeneration: true,
  expiresAt: true,
  lastUsedAt: true,
  lastUsedIp: true,
  revokedAt: true,
  revokedReason: true,
  createdAt: true,
} satisfies Prisma.DeviceTokenSelect;

export type DeviceTokenSummaryRow = Prisma.DeviceTokenGetPayload<{ select: typeof DEVICE_TOKEN_SUMMARY_SELECT }>;

// field by field so a wider row (the hub lists every column) never leaks the operator-only fields
export function deviceTokenSummary(row: DeviceTokenSummaryRow): DeviceTokenSummary {
  return {
    id: row.id,
    deviceId: row.deviceId,
    context: row.context,
    displayId: row.displayId,
    status: row.status,
    rotationGeneration: row.rotationGeneration,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    lastUsedIp: row.lastUsedIp,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
    createdAt: row.createdAt,
  };
}
