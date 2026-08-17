import { describe, expect, it } from 'vitest';
import { parseMdstatDeviceNames } from '.././vg';

describe('parseMdstatDeviceNames', () => {
  it('extracts assembled md device names from /proc/mdstat', () => {
    const mdstat = `Personalities : [raid1] [raid0]
md127 : active raid1 sdb1[1] sda1[0]
      499975488 blocks super 1.2 [2/2] [UU]

md0 : active raid0 sdd1[1] sdc1[0]
      999948288 blocks super 1.2 512k chunks

unused devices: <none>
`;
    expect(parseMdstatDeviceNames(mdstat)).toEqual(['md127', 'md0']);
  });

  it('returns empty when no arrays are assembled', () => {
    const mdstat = `Personalities : [raid1]
unused devices: <none>
`;
    expect(parseMdstatDeviceNames(mdstat)).toEqual([]);
  });

  it('returns empty for an empty mdstat', () => {
    expect(parseMdstatDeviceNames('')).toEqual([]);
  });
});
