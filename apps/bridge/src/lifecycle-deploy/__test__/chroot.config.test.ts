import { afterEach, describe, expect, it } from 'vitest';

import { buildChrootConfig, getChrootConfig, resetChrootConfigForTests } from '../chroot.config';

afterEach(() => {
  resetChrootConfigForTests();
});

describe('buildChrootConfig', () => {
  it('defaults mount/unmount/command timeouts', () => {
    const cfg = buildChrootConfig();
    expect(cfg.mountTimeout).toBe(30);
    expect(cfg.unmountTimeout).toBe(30);
    expect(cfg.commandTimeout).toBe(300);
  });

  it('exposes the canonical mountpoint set in order', () => {
    const cfg = buildChrootConfig();
    const names = cfg.enabledMountpoints.map((mp) => mp[0]);
    expect(cfg.enabledMountpoints.length).toBe(6);
    expect(names).toEqual(['dev', 'proc', 'sys', 'run', 'dev/pts', 'sys/firmware/efi/efivars']);
  });

  it('each mountpoint is a [name, command] tuple with mount in the command', () => {
    const cfg = buildChrootConfig();
    for (const mp of cfg.enabledMountpoints) {
      expect(mp).toHaveLength(2);
      expect(typeof mp[0]).toBe('string');
      expect(typeof mp[1]).toBe('string');
      expect(mp[1]).toContain('mount');
    }
  });
});

describe('getChrootConfig singleton', () => {
  it('returns the cached instance on subsequent calls', () => {
    const a = getChrootConfig();
    const b = getChrootConfig();
    expect(a).toBe(b);
  });
});
