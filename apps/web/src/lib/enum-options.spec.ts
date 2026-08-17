import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { enumOptions, humanizeEnumValue, ipxeTargetOptions } from './enum-options';

describe('humanizeEnumValue', () => {
  it('keeps codes and short acronyms verbatim, title-cases words', () => {
    expect(humanizeEnumValue('IEC_C14')).toBe('IEC C14');
    expect(humanizeEnumValue('NEMA_515P')).toBe('NEMA 515P');
    expect(humanizeEnumValue('RJ45')).toBe('RJ45');
    expect(humanizeEnumValue('USB_C')).toBe('USB C');
    expect(humanizeEnumValue('ETHERNET_100G')).toBe('Ethernet 100G');
    expect(humanizeEnumValue('INFINIBAND_FDR')).toBe('Infiniband FDR');
    expect(humanizeEnumValue('OTHER')).toBe('Other');
    expect(humanizeEnumValue('ACTIVE')).toBe('Active');
  });
});

describe('enumOptions', () => {
  it('maps enum values to {value,label} and applies overrides', () => {
    expect(enumOptions(z.enum(['METERS', 'FEET']), { FEET: 'Feet' })).toEqual([
      { value: 'METERS', label: 'Meters' },
      { value: 'FEET', label: 'Feet' },
    ]);
  });
});

describe('ipxeTargetOptions', () => {
  it('puts the inherit option first with the supplied label and empty value', () => {
    const opts = ipxeTargetOptions('Inherit (default IPXE)');
    expect(opts[0]).toEqual({ label: 'Inherit (default IPXE)', value: '' });
  });

  it('appends the three concrete targets in schema order', () => {
    const opts = ipxeTargetOptions('Inherit');
    expect(opts.slice(1).map((o) => o.value)).toEqual(['IPXE', 'SNP', 'SNPONLY']);
  });

  it('uses friendly labels for the concrete targets (iPXE, SNP, SNP Only)', () => {
    const opts = ipxeTargetOptions('Inherit');
    const byValue = Object.fromEntries(opts.map((o) => [o.value, o.label]));
    expect(byValue.IPXE).toBe('iPXE');
    expect(byValue.SNP).toBe('SNP');
    expect(byValue.SNPONLY).toBe('SNP Only');
  });
});
