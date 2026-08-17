import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderLuksRekey } from '../luks';


const SINGLE_VOL = [
  { device: '/dev/md0', mapper: 'data0', mountpoint: '/data0', fsType: 'xfs', label: 'data0' },
] as never[];

const work = mkdtempSync(join(tmpdir(), 'luks-rekey-rt-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

interface FakeArray {
  name: string;
  isLuks: boolean;
  uuid?: string;
  members?: string[];
}

function runResolve(opts: { rekeyDevice: string; preservedLuksUuids: string[]; arrays: FakeArray[] }): {
  stdout: string;
  code: number;
} {
  const rendered = renderLuksRekey({
    encryptedVolumes: SINGLE_VOL,
    alreadyKeyed: false,
    preservedLuksUuids: opts.preservedLuksUuids,
  });

  const grab = (re: RegExp): string => {
    const m = rendered.match(re);
    if (!m) throw new Error(`could not extract from rendered script: ${re}`);
    return m[0];
  };
  const preservedArr = grab(/PRESERVED_LUKS_UUIDS=\([^)]*\)/);
  const resolveFn = grab(/resolve_device\(\) \{[\s\S]*?\n\}/);
  const arrayContains = grab(/_array_contains\(\) \{[\s\S]*?\n\}/);
  const isMdMember = grab(/_is_md_member\(\) \{[\s\S]*?\n\}/);
  const isPreservedLuks = grab(/_is_preserved_luks\(\) \{[\s\S]*?\n\}/);

  const fakeDev = join(work, 'dev');
  const retarget = (s: string): string =>
    s
      .replaceAll('/dev/md[0-9]*', `${fakeDev}/md[0-9]*`)
      .replaceAll('== /dev/md*', `== ${fakeDev}/md*`)
      .replaceAll('[[ -b "$device" ]]', '[[ -e "$device" ]]')
      .replaceAll('[[ -b "$candidate" ]]', '[[ -e "$candidate" ]]')
      .replaceAll('[[ -b "$other" ]]', '[[ -e "$other" ]]');

  const mkdev = `rm -rf '${fakeDev}'; mkdir -p '${fakeDev}'\n${opts.arrays
    .map((a) => `: > '${fakeDev}/${a.name}'`)
    .join('\n')}`;
  const rekeyDev = opts.rekeyDevice.replace('/dev/', `${fakeDev}/`);

  const stateLines = opts.arrays
    .map((a) => `${a.name}|${a.isLuks ? '1' : '0'}|${a.uuid ?? ''}|${(a.members ?? []).join(',')}`)
    .join('\n');

  const bin = join(work, 'bin');
  const cryptsetup = `#!/usr/bin/env bash
base=$(basename "$2")
line=$(grep "^\${base}|" "$STATE" || true)
isluks=$(echo "$line" | cut -d'|' -f2); uuid=$(echo "$line" | cut -d'|' -f3)
case "$1" in
  isLuks) [[ "$isluks" == "1" ]] && exit 0 || exit 1 ;;
  luksUUID) echo "$uuid"; exit 0 ;;
esac
exit 0
`;
  const mdadm = `#!/usr/bin/env bash
# mdadm --detail <dev> : print member /dev/mdX paths so grep -qw matches.
base=$(basename "$2")
line=$(grep "^\${base}|" "$STATE" || true)
members=$(echo "$line" | cut -d'|' -f4)
IFS=',' read -ra m <<< "$members"
for x in "\${m[@]}"; do [[ -n "$x" ]] && echo "  ${fakeDev}/$x"; done
exit 0
`;

  writeFileSync(join(work, 'state.txt'), `${stateLines}\n`);
  execFileSync('mkdir', ['-p', bin]);
  writeFileSync(join(bin, 'cryptsetup'), cryptsetup, { mode: 0o755 });
  writeFileSync(join(bin, 'mdadm'), mdadm, { mode: 0o755 });

  const harness = `#!/usr/bin/env bash
set -uo pipefail
export STATE='${join(work, 'state.txt')}'
export PATH='${bin}':"$PATH"
${mkdev}
RESOLVED_DEVICES=()
${preservedArr}
${arrayContains}
${retarget(isMdMember)}
${isPreservedLuks}
${retarget(resolveFn)}
resolve_device '${rekeyDev}'
`;
  const harnessPath = join(work, 'harness.sh');
  writeFileSync(harnessPath, harness, { mode: 0o755 });

  try {
    const stdout = execFileSync('bash', [harnessPath], { encoding: 'utf-8' });
    return { stdout: stdout.trim(), code: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; status?: number };
    return { stdout: (err.stdout?.toString() ?? '').trim(), code: err.status ?? 1 };
  }
}

describe('luks-rekey resolve_device — runtime', () => {
  it('ACCEPTS a NEW RAID-backed encrypted volume (curtin-LUKS, UUID not preserved)', () => {
    const { stdout, code } = runResolve({
      rekeyDevice: '/dev/md0',
      preservedLuksUuids: ['PRESERVED-UUID'],
      arrays: [{ name: 'md127', isLuks: true, uuid: 'NEW-CURTIN-UUID' }],
    });
    expect(code).toBe(0);
    expect(stdout.split('\n').pop()).toMatch(/md127$/);
  });

  it('REFUSES a PRESERVED array (UUID in the preserved set) and finds no target', () => {
    const { stdout, code } = runResolve({
      rekeyDevice: '/dev/md0',
      preservedLuksUuids: ['PRESERVED-UUID'],
      arrays: [{ name: 'md0', isLuks: true, uuid: 'PRESERVED-UUID' }],
    });
    expect(code).toBe(1);
    expect(stdout.split('\n').pop()).toMatch(/md0$/);
  });

  it('picks the NEW array and skips the PRESERVED array when both are present', () => {
    const { stdout, code } = runResolve({
      rekeyDevice: '/dev/md0',
      preservedLuksUuids: ['PRESERVED-UUID'],
      arrays: [
        { name: 'md0', isLuks: true, uuid: 'PRESERVED-UUID' },
        { name: 'md127', isLuks: true, uuid: 'NEW-CURTIN-UUID' },
      ],
    });
    expect(code).toBe(0);
    expect(stdout.split('\n').pop()).toMatch(/md127$/);
  });

  it('skips an inner member array of a nested raid50/60 and lands on the outer array', () => {
    const { stdout, code } = runResolve({
      rekeyDevice: '/dev/md0',
      preservedLuksUuids: [],
      arrays: [
        { name: 'md1', isLuks: true, uuid: 'INNER-1' },
        { name: 'md2', isLuks: true, uuid: 'INNER-2' },
        { name: 'md3', isLuks: true, uuid: 'OUTER', members: ['md1', 'md2'] },
      ],
    });
    expect(code).toBe(0);
    expect(stdout.split('\n').pop()).toMatch(/md3$/);
  });
});
