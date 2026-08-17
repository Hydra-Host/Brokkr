import { afterEach, describe, expect, it } from 'vitest';

import { resetIpxeConfigForTests } from '../../ipxe/ipxe.config';
import { buildTftpConfig, getTftpConfig, resetTftpConfigForTests } from '../tftp.config';

afterEach(() => {
  resetTftpConfigForTests();
  resetIpxeConfigForTests();
});

describe('buildTftpConfig — defaults', () => {
  it('emits the canonical TFTP defaults when env is empty', () => {
    const cfg = buildTftpConfig({});
    expect(cfg.tftpEnabled).toBe(true);
    expect(cfg.tftpRootDir).toBe('/opt/brokkr/ipxe-builds');
    expect(cfg.port).toBe(69);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.logTransfers).toBe(true);
    expect(cfg.allowedExtensions).toEqual(['.efi', '.img', '.iso', '.bin', '.pxe', '.cfg', '.txt', '.conf']);
    expect(cfg.maxFileSize).toBe(10 * 1024 * 1024 * 1024);
    expect(cfg.enableWrite).toBe(false);
  });
});

describe('buildTftpConfig — TFTP_ENABLED parsing', () => {
  it('TFTP_ENABLED=True (default) enables the server', () => {
    const cfg = buildTftpConfig({ TFTP_ENABLED: 'True' });
    expect(cfg.tftpEnabled).toBe(true);
  });

  it('TFTP_ENABLED=true (lowercase) enables the server', () => {
    const cfg = buildTftpConfig({ TFTP_ENABLED: 'true' });
    expect(cfg.tftpEnabled).toBe(true);
  });

  it('TFTP_ENABLED=TRUE (uppercase) enables the server', () => {
    const cfg = buildTftpConfig({ TFTP_ENABLED: 'TRUE' });
    expect(cfg.tftpEnabled).toBe(true);
  });

  it('TFTP_ENABLED=False disables the server', () => {
    const cfg = buildTftpConfig({ TFTP_ENABLED: 'False' });
    expect(cfg.tftpEnabled).toBe(false);
  });

  it('TFTP_ENABLED=false disables the server', () => {
    const cfg = buildTftpConfig({ TFTP_ENABLED: 'false' });
    expect(cfg.tftpEnabled).toBe(false);
  });

  it('TFTP_ENABLED=0 disables the server (not "true")', () => {
    const cfg = buildTftpConfig({ TFTP_ENABLED: '0' });
    expect(cfg.tftpEnabled).toBe(false);
  });

  it('TFTP_ENABLED=anything-else disables the server', () => {
    const cfg = buildTftpConfig({ TFTP_ENABLED: 'enabled' });
    expect(cfg.tftpEnabled).toBe(false);
  });

  it('TFTP_ENABLED missing falls through to "True" → enabled', () => {
    const cfg = buildTftpConfig({});
    expect(cfg.tftpEnabled).toBe(true);
  });
});

describe('getTftpConfig singleton', () => {
  it('returns the cached instance on subsequent calls', () => {
    const a = getTftpConfig();
    const b = getTftpConfig();
    expect(a).toBe(b);
  });
});
