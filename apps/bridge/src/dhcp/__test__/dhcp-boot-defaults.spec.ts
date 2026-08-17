import { describe, expect, it } from 'vitest';

import { IPXE_VALID_ARCHES, IPXE_VALID_EXTS, IPXE_VALID_TARGETS } from '../../tftp/tftp-dyn-file.js';
import {
  assertServableBootfile,
  defaultBootfileByArch,
  defaultBridgeBootfile,
  isServableBootfile,
  resolveIpxeTarget,
} from '../dhcp-boot-defaults.js';

describe('dhcp-boot-defaults', () => {
  it('the canonical default bootfile is servable by the TFTP server', () => {
    const stem = defaultBridgeBootfile();
    expect(stem).toBe('ipxe-amd64.efi');
    expect(isServableBootfile(stem)).toBe(true);
  });

  it('every per-arch default decomposes into a TFTP-allowlisted target/arch/ext', () => {
    const byArch = defaultBootfileByArch();
    expect(byArch.size).toBeGreaterThan(0);
    for (const file of byArch.values()) {
      expect(isServableBootfile(file)).toBe(true);
      const [target, archDir] = file.slice(0, file.lastIndexOf('.')).split('-');
      const ext = file.slice(file.lastIndexOf('.') + 1);
      expect(IPXE_VALID_TARGETS.has(target)).toBe(true);
      expect(IPXE_VALID_ARCHES.has(archDir)).toBe(true);
      expect(IPXE_VALID_EXTS.has(ext)).toBe(true);
    }
  });

  it('maps the EFI ARM64 client arch (0x000b) to the arm64 stem', () => {
    const byArch = defaultBootfileByArch();
    expect(byArch.get(0x000b)).toBe('ipxe-arm64.efi');
  });

  it('maps the legacy-fleet arm64 client archs (0x000a/0x0011/0x0013) to the arm64 stem', () => {
    const byArch = defaultBootfileByArch();
    expect(byArch.get(0x000a)).toBe('ipxe-arm64.efi');
    expect(byArch.get(0x0011)).toBe('ipxe-arm64.efi');
    expect(byArch.get(0x0013)).toBe('ipxe-arm64.efi');
  });

  it('maps EFI x86-64 client archs (0x0002/0x0007/0x0008/0x0009) to the amd64 stem', () => {
    const byArch = defaultBootfileByArch();
    expect(byArch.get(0x0002)).toBe('ipxe-amd64.efi');
    expect(byArch.get(0x0007)).toBe('ipxe-amd64.efi');
    expect(byArch.get(0x0008)).toBe('ipxe-amd64.efi');
    expect(byArch.get(0x0009)).toBe('ipxe-amd64.efi');
  });

  it('rejects unservable stems (unknown target/arch/ext, traversal, bare names)', () => {
    expect(isServableBootfile('grub-amd64.efi')).toBe(false);
    expect(isServableBootfile('snponly-mips.efi')).toBe(false);
    expect(isServableBootfile('snponly-amd64.bin')).toBe(false);
    expect(isServableBootfile('snponly.efi')).toBe(false);
    expect(isServableBootfile('pxelinux.0')).toBe(false);
    expect(isServableBootfile('10.0.0.1')).toBe(false);
  });

  it('accepts a commit-hash-suffixed stem the TFTP resolver still serves', () => {
    expect(isServableBootfile('snponly-amd64-deadbeef.efi')).toBe(true);
    expect(isServableBootfile('snponly-amd64-extra.efi')).toBe(true);
    expect(isServableBootfile('ipxe-arm64-abc123-more.efi')).toBe(true);
    expect(isServableBootfile('grub-amd64-deadbeef.efi')).toBe(false);
    expect(isServableBootfile('snponly-mips-deadbeef.efi')).toBe(false);
  });

  it('strips a directory prefix before decomposing', () => {
    expect(isServableBootfile('boot/snponly-amd64.efi')).toBe(true);
  });

  it('assertServableBootfile passes a derived stem and throws on an unservable one', () => {
    expect(assertServableBootfile('snponly-amd64.efi')).toBe('snponly-amd64.efi');
    expect(() => assertServableBootfile('grub-amd64.efi')).toThrow(/not servable/);
  });

  describe('resolveIpxeTarget', () => {
    it('maps IPXE to ipxe', () => {
      expect(resolveIpxeTarget('IPXE')).toBe('ipxe');
    });

    it('maps SNP to snp', () => {
      expect(resolveIpxeTarget('SNP')).toBe('snp');
    });

    it('maps SNPONLY to snponly', () => {
      expect(resolveIpxeTarget('SNPONLY')).toBe('snponly');
    });

    it('falls back to the default for null', () => {
      expect(resolveIpxeTarget(null)).toBe('ipxe');
    });

    it('falls back to the default for undefined', () => {
      expect(resolveIpxeTarget(undefined)).toBe('ipxe');
    });
  });

  it('defaultBridgeBootfile respects a custom target', () => {
    expect(defaultBridgeBootfile('ipxe')).toBe('ipxe-amd64.efi');
    expect(defaultBridgeBootfile('snp')).toBe('snp-amd64.efi');
  });

  it('defaultBootfileByArch respects a custom target', () => {
    const byArch = defaultBootfileByArch('ipxe');
    for (const file of byArch.values()) {
      expect(file).toMatch(/^ipxe-/);
      expect(isServableBootfile(file)).toBe(true);
    }
  });
});
