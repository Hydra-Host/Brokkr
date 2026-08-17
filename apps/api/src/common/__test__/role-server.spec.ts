import { DeviceRole } from '@repo/database';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SERVER_ROLES, roleGetsServer } from '../role-server';

describe('roleGetsServer', () => {
  it.each([
    DeviceRole.Baremetal,
    DeviceRole.Hypervisor,
    DeviceRole.Cluster,
    DeviceRole.DiscoveredHost,
    DeviceRole.OffMarketplaceHost,
    DeviceRole.Decommissioned,
  ])('returns true for compute-host role %s', (role) => {
    expect(roleGetsServer(role)).toBe(true);
  });

  it.each([DeviceRole.Bridge, DeviceRole.VM, DeviceRole.NetworkSwitch])(
    'returns false for non-host role %s',
    (role) => {
      expect(roleGetsServer(role)).toBe(false);
    },
  );

  it('returns false for null role (unset)', () => {
    expect(roleGetsServer(null)).toBe(false);
  });

  it('exports SERVER_ROLES as the same set used by the helper', () => {
    expect(SERVER_ROLES.size).toBeGreaterThan(0);
    for (const role of SERVER_ROLES) {
      expect(roleGetsServer(role)).toBe(true);
    }
  });
});

describe('move_rentals_to_server migration eligibility set', () => {
  const migrationSql = readFileSync(
    join(
      __dirname,
      '../../../../../packages/database/prisma/migrations/20260527213000_move_rentals_to_server/migration.sql',
    ),
    'utf8',
  );

  const openAnchor = 'FROM "Device" d';
  const closeAnchor = 'AND s.id IS NULL';
  const openIdx = migrationSql.indexOf(openAnchor);
  const closeIdx = migrationSql.indexOf(closeAnchor);
  if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) {
    throw new Error(
      `Migration SQL anchors not found — open=${openIdx} close=${closeIdx}. ` +
        'Update anchor strings in this test to match the current SQL.',
    );
  }
  const backfillRoleList = migrationSql.slice(openIdx, closeIdx).match(/'(\w+)'::"DeviceRole"/g);

  it('parses the inline backfill role list out of the migration SQL', () => {
    expect(backfillRoleList).not.toBeNull();
  });

  it('matches SERVER_ROLES exactly (no drift between SQL and TypeScript)', () => {
    const sqlRoles = new Set((backfillRoleList ?? []).map((m) => m.replace(/'(\w+)'::"DeviceRole"/, '$1')));
    const preRenameRoles = new Set(
      [...SERVER_ROLES].map((role) => (role === DeviceRole.Decommissioned ? 'Deprecated' : role)),
    );
    expect(sqlRoles).toEqual(preRenameRoles);
  });
});
