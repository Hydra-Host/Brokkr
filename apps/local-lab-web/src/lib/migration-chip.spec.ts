import { describe, expect, it } from 'vitest';

import type { DbMigrations } from '@/contract';
import { migrationChipState } from './migration-chip';

const base: DbMigrations = {
  tableExists: true,
  applied: [],
  onDisk: [],
  pending: [],
  missing: [],
  failed: [],
};

describe('migrationChipState', () => {
  it('surfaces the red failed chip even when the on-disk note is set [bugbot 17f0621e]', () => {
    const res = migrationChipState({ ...base, failed: ['x'], note: 'on-disk unavailable' });
    expect(res.tone).toBe('red');
    expect(res.text).toBe('1 failed');
  });

  it('shows the amber on-disk-unavailable note when nothing failed', () => {
    const res = migrationChipState({ ...base, note: 'repo path not configured' });
    expect(res.tone).toBe('amber');
    expect(res.text).toBe('migrations: on-disk unavailable');
  });

  it('keeps the no-schema amber chip ahead of everything when the table is absent', () => {
    const res = migrationChipState({ ...base, tableExists: false, failed: ['x'] });
    expect(res.tone).toBe('amber');
    expect(res.text).toBe('no schema — run migrate deploy or devenv up');
  });
});
