import { z } from 'zod';
import { validateDiskLayoutEncryption, validateRaidDiskCount } from '../disk-layout-validation';

type Layout = { mountpoint: string; encrypt?: boolean; wipe?: boolean; disks?: string[]; config?: string };

function makeSchema(mode: 'provision' | 'reprovision') {
  return z
    .object({ diskLayouts: z.array(z.any()) })
    .superRefine((data, ctx) => validateDiskLayoutEncryption(data.diskLayouts as Layout[], ctx, mode));
}

function errorsFor(mode: 'provision' | 'reprovision', diskLayouts: Layout[]): string[] {
  const result = makeSchema(mode).safeParse({ diskLayouts });
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

describe('validateDiskLayoutEncryption', () => {
  it('rejects encryption on restricted system mountpoints', () => {
    for (const mountpoint of ['/', '/home', '/tmp', '/usr', '/var']) {
      const errors = errorsFor('provision', [{ mountpoint, encrypt: true, wipe: true }]);
      expect(errors).toContain(`Encryption is not supported on system mountpoint "${mountpoint}"`);
    }
  });

  it('rejects encrypt + preserve on reprovision', () => {
    const errors = errorsFor('reprovision', [{ mountpoint: '/data', encrypt: true, wipe: false }]);
    expect(errors).toContain('Cannot encrypt a preserved disk group — encryption requires a fresh format');
  });

  it('rejects preserve (wipe:false) on provision', () => {
    const errors = errorsFor('provision', [{ mountpoint: '/data', wipe: false }]);
    expect(errors).toContain(
      'Disk preservation is only available during reprovision — fresh provisions must wipe all disks',
    );
  });

  it('rejects preserving the root group on reprovision (server/client parity)', () => {
    const errors = errorsFor('reprovision', [{ mountpoint: '/', wipe: false }]);
    expect(errors).toContain('Cannot preserve the root "/" disk group — the OS/root must be wiped to rebuild EFI/root');
  });

  it('allows preserving a non-root group on reprovision', () => {
    expect(errorsFor('reprovision', [{ mountpoint: '/data', wipe: false }])).toHaveLength(0);
  });

  it('allows wiping the root group on reprovision', () => {
    expect(errorsFor('reprovision', [{ mountpoint: '/', wipe: true }])).toHaveLength(0);
  });

  it('rejects the same disk in more than one group (server/client parity)', () => {
    const errors = errorsFor('reprovision', [
      { mountpoint: '/', wipe: true, disks: ['wwn-1'] },
      { mountpoint: '/data', wipe: false, disks: ['wwn-1'] },
    ]);
    expect(errors).toContain(
      'Disk "wwn-1" appears in more than one disk group; each disk may belong to exactly one group',
    );
  });

  it('allows distinct disks across groups', () => {
    expect(
      errorsFor('reprovision', [
        { mountpoint: '/', wipe: true, disks: ['wwn-1'] },
        { mountpoint: '/data', wipe: false, disks: ['wwn-2'] },
      ]),
    ).toHaveLength(0);
  });

  it('ignores non-direct rows when a direct row is present (matches submission collapse)', () => {
    expect(
      errorsFor('provision', [
        { mountpoint: '/', config: 'direct', wipe: true, disks: ['wwn-1'] },
        { mountpoint: '/data', config: 'lvm', wipe: true, disks: ['wwn-1'] },
      ]),
    ).toHaveLength(0);
  });

  it('does not flag encrypt/wipe on dropped rows when a direct row collapses the submission', () => {
    expect(
      errorsFor('provision', [
        { mountpoint: '/', config: 'direct', wipe: true, disks: ['wwn-1'] },
        { mountpoint: '/data', config: 'lvm', encrypt: true, wipe: false, disks: ['wwn-2'] },
      ]),
    ).toHaveLength(0);
  });

  it('validates the collapsed direct row at its effective mountpoint "/"', () => {
    const errors = errorsFor('provision', [
      { mountpoint: '/whatever', config: 'direct', encrypt: true, wipe: true, disks: ['wwn-1'] },
    ]);
    expect(errors).toContain('Encryption is not supported on system mountpoint "/"');
  });

  it('rejects a RAID layout with too few disks (server/client parity)', () => {
    const errors = errorsFor('provision', [{ mountpoint: '/', config: 'raid5', wipe: true, disks: ['a', 'b'] }]);
    expect(errors).toContain('RAID level "raid5" requires at least 3 disks; got 2');
  });

  it('rejects raid60 below its 8-disk nested minimum', () => {
    const errors = errorsFor('provision', [
      { mountpoint: '/', config: 'raid60', wipe: true, disks: ['a', 'b', 'c', 'd', 'e', 'f'] },
    ]);
    expect(errors).toContain('RAID level "raid60" requires at least 8 disks; got 6');
  });
});

describe('validateRaidDiskCount', () => {
  it('returns null for non-RAID configs and unknown levels', () => {
    expect(validateRaidDiskCount('lvm', 1)).toBeNull();
    expect(validateRaidDiskCount('direct', 1)).toBeNull();
    expect(validateRaidDiskCount(undefined, 1)).toBeNull();
    expect(validateRaidDiskCount('raid99', 1)).toBeNull();
  });

  it('enforces per-level minimums', () => {
    expect(validateRaidDiskCount('raid0', 1)).toMatch(/at least 2/);
    expect(validateRaidDiskCount('raid5', 2)).toMatch(/at least 3/);
    expect(validateRaidDiskCount('raid6', 3)).toMatch(/at least 4/);
    expect(validateRaidDiskCount('raid50', 5)).toMatch(/at least 6/);
    expect(validateRaidDiskCount('raid60', 7)).toMatch(/at least 8/);
    expect(validateRaidDiskCount('raid5', 3)).toBeNull();
  });

  it('requires an even count for mirror levels', () => {
    expect(validateRaidDiskCount('raid1', 3)).toMatch(/even number/);
    expect(validateRaidDiskCount('raid10', 5)).toMatch(/even number/);
    expect(validateRaidDiskCount('raid10', 4)).toBeNull();
  });
});
