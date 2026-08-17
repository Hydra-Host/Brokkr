import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderLuksLock, renderLuksRekey, renderLuksUnlock } from '../luks';

const FIXTURES = join(__dirname, 'fixtures', 'synthetic', 'luks');
const golden = (name: string): string => readFileSync(join(FIXTURES, `${name}.txt`), 'utf-8');

const SINGLE_VOL = [
  {
    device: '/dev/md0',
    mapper: 'data0',
    mountpoint: '/data0',
    fsType: 'xfs',
    label: 'data0',
  },
] as never[];

const THREE_VOLS = [
  { device: '/dev/md0', mapper: 'data0', mountpoint: '/data0', fsType: 'xfs', label: 'data0' },
  { device: '/dev/md1', mapper: 'data1', mountpoint: '/data1', fsType: 'ext4', label: 'data1' },
  { device: '/dev/md2', mapper: 'data2', mountpoint: '/data2', fsType: 'xfs', label: 'data2' },
] as never[];

describe('renderLuksLock', () => {
  it('matches the sandbox golden for a single encrypted volume', () => {
    const out = renderLuksLock({ encryptedVolumes: SINGLE_VOL });
    expect(out).toBe(golden('luks-lock_single-vol'));
  });

  it('matches the sandbox golden for three encrypted volumes', () => {
    const out = renderLuksLock({ encryptedVolumes: THREE_VOLS });
    expect(out).toBe(golden('luks-lock_three-vols'));
  });

  it('emits parallel mapper and mountpoint arrays in declaration order', () => {
    const out = renderLuksLock({ encryptedVolumes: THREE_VOLS });
    expect(out).toContain(`MAPPERS=(  'data0'  'data1'  'data2')`);
    expect(out).toContain(`MOUNTPOINTS=(  '/data0'  '/data1'  '/data2')`);
  });
});

describe('renderLuksUnlock', () => {
  it('matches the sandbox golden for a single encrypted volume', () => {
    const out = renderLuksUnlock({ encryptedVolumes: SINGLE_VOL });
    expect(out).toBe(golden('luks-unlock_single-vol'));
  });

  it('matches the sandbox golden for three encrypted volumes', () => {
    const out = renderLuksUnlock({ encryptedVolumes: THREE_VOLS });
    expect(out).toBe(golden('luks-unlock_three-vols'));
  });

  it('emits DEVICES / MAPPERS / MOUNTPOINTS arrays in declaration order', () => {
    const out = renderLuksUnlock({ encryptedVolumes: THREE_VOLS });
    expect(out).toContain(`DEVICES=(  '/dev/md0'  '/dev/md1'  '/dev/md2')`);
    expect(out).toContain(`MAPPERS=(  'data0'  'data1'  'data2')`);
    expect(out).toContain(`MOUNTPOINTS=(  '/data0'  '/data1'  '/data2')`);
  });

  it('resolve_device claims arrays so multiple preserved md arrays do not cross-map', () => {
    const out = renderLuksUnlock({ encryptedVolumes: THREE_VOLS });
    expect(out).toContain('_array_contains "$candidate" "${RESOLVED_DEVICES[@]:-}" && continue');
    expect(out).toContain('cryptsetup isLuks "$candidate"');
    expect(out).toContain('RESOLVED_DEVICES+=("$device")');
  });

  it('resolve_device has no unconditional fallback to a non-LUKS array', () => {
    const out = renderLuksUnlock({ encryptedVolumes: THREE_VOLS });
    expect(out).not.toContain('fallback, no LUKS match');
  });

  it('claims an already-open volume array so a later locked volume cannot cross-map onto it', () => {
    const out = renderLuksUnlock({ encryptedVolumes: THREE_VOLS });
    expect(out).toContain('if claimed=$(resolve_device "${DEVICES[$i]}" "$want_uuid"); then');
    expect(out).toContain('RESOLVED_DEVICES+=("$claimed")');
  });

  it('bakes a parallel LUKS_UUIDS array and resolves preserved arrays by stored UUID', () => {
    const out = renderLuksUnlock({
      encryptedVolumes: [
        {
          device: '/dev/md0',
          mapper: 'pcrypt-0',
          mountpoint: '/data0',
          fsType: 'xfs',
          label: 'data0',
          luksUuid: 'uuid-A',
        },
        {
          device: '/dev/md1',
          mapper: 'pcrypt-1',
          mountpoint: '/data1',
          fsType: 'xfs',
          label: 'data1',
          luksUuid: 'uuid-B',
        },
      ] as never[],
    });
    expect(out).toContain(`LUKS_UUIDS=(  'uuid-A'  'uuid-B')`);
    expect(out).toContain('want_uuid="${LUKS_UUIDS[$i]:-}"');
    expect(out).toContain('cryptsetup luksUUID "$candidate"');
  });

  it('guards cryptsetup open so one failure does not abort remaining unlocks', () => {
    const out = renderLuksUnlock({ encryptedVolumes: THREE_VOLS });
    expect(out).toContain('continuing with remaining volumes');
    expect(out).toContain('[[ $failed -eq 0 ]] || exit 1');
  });
});

describe('renderLuksRekey', () => {
  it('matches the sandbox golden for single-vol, not-yet-keyed', () => {
    const out = renderLuksRekey({ encryptedVolumes: SINGLE_VOL, alreadyKeyed: false });
    expect(out).toBe(golden('luks-rekey_single-vol-not-keyed'));
  });

  it('matches the sandbox golden for single-vol, already-keyed (skip luksAddKey)', () => {
    const out = renderLuksRekey({ encryptedVolumes: SINGLE_VOL, alreadyKeyed: true });
    expect(out).toBe(golden('luks-rekey_single-vol-already-keyed'));
  });

  it('matches the sandbox golden for three encrypted volumes', () => {
    const out = renderLuksRekey({ encryptedVolumes: THREE_VOLS, alreadyKeyed: false });
    expect(out).toBe(golden('luks-rekey_three-vols'));
  });

  it('sets ALREADY_KEYED=1 when alreadyKeyed=true', () => {
    const out = renderLuksRekey({ encryptedVolumes: SINGLE_VOL, alreadyKeyed: true });
    expect(out).toContain('ALREADY_KEYED=1');
  });

  it('sets ALREADY_KEYED=0 when alreadyKeyed=false', () => {
    const out = renderLuksRekey({ encryptedVolumes: SINGLE_VOL, alreadyKeyed: false });
    expect(out).toContain('ALREADY_KEYED=0');
  });

  it('resolve_device refuses PRESERVED md arrays (by UUID) but accepts a NEW curtin-LUKS array', () => {
    const out = renderLuksRekey({ encryptedVolumes: SINGLE_VOL, alreadyKeyed: false });
    expect(out).toContain('_is_preserved_luks "$candidate"');
    expect(out).toContain('preserved LUKS array (UUID in preserved set)');
    expect(out).toContain('non-preserved LUKS md, eligible for rekey');
    expect(out).not.toContain('already LUKS (preserved/foreign array)');
    expect(out).not.toContain('LUKS header found');
    expect(out).not.toContain('fallback, no LUKS match');
  });

  it('_is_preserved_luks keys on the LUKS-header UUID against the baked preserved set', () => {
    const out = renderLuksRekey({
      encryptedVolumes: SINGLE_VOL,
      alreadyKeyed: false,
      preservedLuksUuids: ['preserved-uuid-A'],
    });
    expect(out).toContain(`PRESERVED_LUKS_UUIDS=(  'preserved-uuid-A')`);
    expect(out).toContain('cryptsetup luksUUID "$arr"');
    expect(out).toContain('_array_contains "$uuid" "${PRESERVED_LUKS_UUIDS[@]:-}"');
  });

  it('resolve_device fast path refuses a preserved array, an inner member, and a non-LUKS array at the baked path', () => {
    const out = renderLuksRekey({ encryptedVolumes: SINGLE_VOL, alreadyKeyed: false });
    expect(out).toContain('if [[ "$device" == /dev/md* ]]; then');
    expect(out).toContain('cryptsetup isLuks "$device" 2>/dev/null');
    expect(out).toContain('! _is_preserved_luks "$device" && ! _is_md_member "$device"; then');
    expect(out).not.toContain('[[ -b "$device" ]] && echo "$device" && return 0');
  });

  it('resolve_device scan requires a curtin-LUKS array before treating it as a rekey target', () => {
    const out = renderLuksRekey({ encryptedVolumes: SINGLE_VOL, alreadyKeyed: false });
    expect(out).toContain('if ! cryptsetup isLuks "$candidate" 2>/dev/null; then');
    expect(out).toContain('not a LUKS array (no curtin LUKS header)');
  });

  it('resolve_device excludes md arrays already claimed by an earlier resolve', () => {
    const out = renderLuksRekey({ encryptedVolumes: THREE_VOLS, alreadyKeyed: false });
    expect(out).toContain('_array_contains "$candidate" "${RESOLVED_DEVICES[@]:-}" && continue');
  });

  it('resolve_device skips inner member arrays of a nested RAID50/60 and only targets the top-level outer array', () => {
    const out = renderLuksRekey({ encryptedVolumes: SINGLE_VOL, alreadyKeyed: false });
    expect(out).toContain('_is_md_member()');
    expect(out).toContain('! _is_preserved_luks "$device" && ! _is_md_member "$device"; then');
    expect(out).toContain('if _is_md_member "$candidate"; then');
    expect(out).toContain('inner member of another array (nested RAID50/60)');
    expect(out).toContain('if detail=$(mdadm --detail "$other" 2>/dev/null); then :; fi');
    expect(out).toContain('if grep -qw -- "$arr" <<<"$detail"; then');
    expect(out).not.toContain('mdadm --detail "$other" 2>/dev/null | grep -qw');
  });

  it('emits all 5 parallel arrays (device, mapper, mountpoint, fs_type, label) in declaration order', () => {
    const out = renderLuksRekey({ encryptedVolumes: THREE_VOLS, alreadyKeyed: false });
    expect(out).toContain(`DEVICES=(  '/dev/md0'  '/dev/md1'  '/dev/md2')`);
    expect(out).toContain(`MAPPERS=(  'data0'  'data1'  'data2')`);
    expect(out).toContain(`MOUNTPOINTS=(  '/data0'  '/data1'  '/data2')`);
    expect(out).toContain(`FS_TYPES=(  'xfs'  'ext4'  'xfs')`);
    expect(out).toContain(`FS_LABELS=(  'data0'  'data1'  'data2')`);
  });

  it('rewrites fstab using the inner FILESYSTEM UUID read off the opened mapper, not the LUKS-header UUID', () => {
    const out = renderLuksRekey({ encryptedVolumes: SINGLE_VOL, alreadyKeyed: false });

    expect(out).toContain('new_fs_uuid=$(blkid -o value -s UUID "/dev/mapper/$mapper")');
    expect(out).toContain('awk -v mp="$mountpoint" \'$1 !~ /^#/ && $2 == mp { print $1 }\' /etc/fstab');
    expect(out).toContain('sed -i "s/${old_fs_uuid}/${new_fs_uuid}/g" /etc/fstab');

    expect(out).toContain('sed -i "s/${old_header_uuid}/${new_header_uuid}/g" /etc/crypttab');

    expect(out).not.toContain('/etc/fstab\n    info "  Updated fstab: ${old_uuid_nodash}');
    expect(out).not.toContain('old_uuid_nodash');
  });

  it('reads the new fs UUID only after the filesystem is created (mkfs precedes the fstab rewrite)', () => {
    const out = renderLuksRekey({ encryptedVolumes: SINGLE_VOL, alreadyKeyed: false });
    const mkfsIdx = out.indexOf('mkfs.xfs');
    const fsUuidIdx = out.indexOf('new_fs_uuid=$(blkid');
    expect(mkfsIdx).toBeGreaterThan(-1);
    expect(fsUuidIdx).toBeGreaterThan(mkfsIdx);
  });
});

describe('LUKS renderers — shell-injection hardening', () => {
  const HOSTILE = [
    { device: '/dev/md0', mapper: 'data0', mountpoint: `/data'; rm -rf / #`, fsType: 'xfs', label: 'data0' },
  ] as never[];

  it('shell-quotes operator-controlled fields so metacharacters cannot break out', () => {
    const out = renderLuksRekey({ encryptedVolumes: HOSTILE, alreadyKeyed: false });
    expect(out).toContain(`'/data'\\''; rm -rf / #'`);
    expect(out).not.toContain(`"/data'; rm -rf / #"`);
  });

  it('rejects control characters (e.g. embedded newline) in any volume field', () => {
    const withNewline = [
      { device: '/dev/md0', mapper: 'data0', mountpoint: '/data\n0', fsType: 'xfs', label: 'data0' },
    ] as never[];
    expect(() => renderLuksRekey({ encryptedVolumes: withNewline, alreadyKeyed: false })).toThrow(/control characters/);
    expect(() => renderLuksUnlock({ encryptedVolumes: withNewline })).toThrow(/control characters/);
    expect(() => renderLuksLock({ encryptedVolumes: withNewline })).toThrow(/control characters/);
  });
});

describe('LUKS renderers — empty volumes list', () => {
  it('renders all three scripts without crashing when volumes=[]', () => {
    expect(() => renderLuksLock({ encryptedVolumes: [] })).not.toThrow();
    expect(() => renderLuksUnlock({ encryptedVolumes: [] })).not.toThrow();
    expect(() => renderLuksRekey({ encryptedVolumes: [], alreadyKeyed: false })).not.toThrow();
  });
});
