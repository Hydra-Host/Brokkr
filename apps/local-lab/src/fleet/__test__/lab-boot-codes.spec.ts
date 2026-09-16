import { describe, expect, it } from 'vitest';

import { PREFIX_FINDING_CODES } from '@repo/local-lab-contract';
import { BOOT_CODES } from '@repo/utils';
import { LAB_BOOT_CODES } from '../boot-readiness.service';

describe('LAB_BOOT_CODES', () => {
  it('pins the codes the lab names', () => {
    expect(LAB_BOOT_CODES).toEqual({
      unevaluated: 'PXE-107',
      noSubnet: 'PXE-102',
      refused: 'PXE-110',
      silent: 'PXE-111',
      authoritative: 'PXE-112',
      noPeer: 'PXE-04',
      noFullImage: 'PXE-113',
    });
  });

  it('every lab code is error or warn in the registry', () => {
    for (const code of Object.values(LAB_BOOT_CODES)) {
      expect(['error', 'warn']).toContain(BOOT_CODES[code].severity);
    }
  });

  it("keeps every prefix-scoped lab code inside the contract's prefix finding codes", () => {
    expect(PREFIX_FINDING_CODES).toContain(LAB_BOOT_CODES.noSubnet);
    expect(PREFIX_FINDING_CODES).toContain(LAB_BOOT_CODES.authoritative);
    expect(PREFIX_FINDING_CODES).toContain(LAB_BOOT_CODES.noPeer);
  });
});
