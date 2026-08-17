import { describe, expect, it } from 'vitest';

import { cleanFstab } from '../deploy-templates.js';

describe('cleanFstab', () => {
  it('normalizes and dedups /boot/efi entries', () => {
    const raw = [
      '# header',
      '',
      'UUID=1 / ext4 defaults 0 1',
      'UUID=2 /boot/efi vfat defaults 0 1',
      'UUID=3 /boot/efi2 vfat defaults 0 1',
    ].join('\n');
    const cleaned = cleanFstab(raw);
    expect(cleaned).toBe(
      [
        '# header',
        '',
        'UUID=1 / ext4 defaults 0 1',
        'UUID=2 /boot/efi vfat defaults 0 1',
        '# UUID=3 /boot/efi vfat defaults 0 1',
      ].join('\n') + '\n\n',
    );
  });

  it('keeps short and comment lines as-is', () => {
    expect(cleanFstab('justonefield\n# comment')).toBe('justonefield\n# comment\n\n');
  });

  it('ends with a double newline without tripling on trailing input newlines', () => {
    expect(cleanFstab('UUID=1 / ext4 defaults 0 1\n')).toBe('UUID=1 / ext4 defaults 0 1\n\n');
  });
});
