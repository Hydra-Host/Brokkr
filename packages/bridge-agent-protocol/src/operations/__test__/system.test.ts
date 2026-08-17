import { describe, expect, it } from 'vitest';

import { removeEfiBootEntry } from '../system.js';

describe('removeEfiBootEntry.input boot_id', () => {
  it('accepts valid EFI entry ids (1-4 hex digits, any case)', () => {
    for (const boot_id of ['0', '1', '0001', 'ABCD', 'abcd', 'f00d']) {
      expect(removeEfiBootEntry.input.safeParse({ boot_id }).success).toBe(true);
    }
  });

  it('rejects dash-prefixed values (efibootmgr argument injection)', () => {
    for (const boot_id of ['-v', '-b', '--help']) {
      expect(removeEfiBootEntry.input.safeParse({ boot_id }).success).toBe(false);
    }
  });

  it('rejects otherwise-malformed ids (too long, non-hex, whitespace, empty)', () => {
    for (const boot_id of ['00001', 'GHIJ', '00 1', '0001\n6.6.6.6', '', '0x01']) {
      expect(removeEfiBootEntry.input.safeParse({ boot_id }).success).toBe(false);
    }
  });
});
