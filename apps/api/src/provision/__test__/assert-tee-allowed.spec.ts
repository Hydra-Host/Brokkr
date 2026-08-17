import { BadRequestException } from '@nestjs/common';
import { TeeCapability } from '@repo/database';
import type { ServerSpecsInput } from '@repo/device-domain';
import { describe, expect, it } from 'vitest';
import { assertTeeAllowed, isTeeRequested } from '../assert-tee-allowed';

describe('isTeeRequested', () => {
  it('returns true when the explicit tee flag is true', () => {
    expect(isTeeRequested('ubuntu-noble-vanilla', true)).toBe(true);
  });

  it('returns true when the OS slug is ipxe-custom-tee, even with tee=false', () => {
    expect(isTeeRequested('ipxe-custom-tee', false)).toBe(true);
  });

  it('returns true when the OS slug is ipxe-custom-tee and tee is undefined', () => {
    expect(isTeeRequested('ipxe-custom-tee', undefined)).toBe(true);
  });

  it('returns true when customizations include tee-setup', () => {
    expect(isTeeRequested('ubuntu-noble-vanilla', false, ['tee-setup'])).toBe(true);
  });

  it('returns true for a -tee platform variant base (e.g. ubuntu-noble-tee), even with tee=false', () => {
    expect(isTeeRequested('ubuntu-noble-tee', false)).toBe(true);
  });

  it('returns false when customizations are empty or null', () => {
    expect(isTeeRequested('ipxe-custom', false, [])).toBe(false);
    expect(isTeeRequested('ipxe-custom', false, null)).toBe(false);
  });

  it('returns false when neither flag, slug, nor customizations imply TEE', () => {
    expect(isTeeRequested('ipxe-custom', false)).toBe(false);
    expect(isTeeRequested('ubuntu-noble-vanilla', undefined)).toBe(false);
  });
});

describe('assertTeeAllowed', () => {
  const teeCapableDevice: ServerSpecsInput = { server: { teeCapable: TeeCapability.TRUE } };
  const teeIncapableDevice: ServerSpecsInput = { server: { teeCapable: TeeCapability.PATCH } };
  const noServerDevice: ServerSpecsInput = { server: null };

  it('allows TEE on a capable device regardless of OS (iPXE-Custom, -tee variant, or standard base)', () => {
    expect(() => assertTeeAllowed(teeCapableDevice)).not.toThrow();
  });

  it('throws when device lacks TEE capability', () => {
    expect(() => assertTeeAllowed(teeIncapableDevice)).toThrow(BadRequestException);
    expect(() => assertTeeAllowed(teeIncapableDevice)).toThrow('TEE is not supported on this device');
  });

  it('throws when device has no server record', () => {
    expect(() => assertTeeAllowed(noServerDevice)).toThrow(BadRequestException);
    expect(() => assertTeeAllowed(noServerDevice)).toThrow('TEE is not supported on this device');
  });
});
