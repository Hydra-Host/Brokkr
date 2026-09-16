import { BOOT_CODE_LIST, BOOT_CODES, BOOT_SEVERITIES, bootCodeSpec } from '..';

describe('BOOT_CODES', () => {
  it('keys every entry by its own code', () => {
    for (const [key, spec] of Object.entries(BOOT_CODES)) expect(spec.code).toBe(key);
  });

  it('gives every code a remedy naming an action', () => {
    for (const spec of Object.values(BOOT_CODES)) expect(spec.remedy.length).toBeGreaterThan(20);
  });

  it('keeps startup codes below the runtime range', () => {
    const startup = Object.keys(BOOT_CODES).filter((c) => Number(c.slice(4)) < 100);
    expect(startup).toContain('PXE-06');
    expect(startup).not.toContain('PXE-101');
  });

  it('names the runtime pxe trail codes with their severities', () => {
    expect(BOOT_CODES['PXE-110'].severity).toBe('error');
    expect(BOOT_CODES['PXE-111'].severity).toBe('warn');
  });

  it('names PXE-112 and PXE-113 as errors', () => {
    expect(BOOT_CODES['PXE-112'].severity).toBe('error');
    expect(BOOT_CODES['PXE-113'].severity).toBe('error');
  });

  it('throws on an unknown code rather than returning undefined', () => {
    // @ts-expect-error exercising the runtime guard
    expect(() => bootCodeSpec('PXE-999')).toThrow('unknown boot code');
  });
});

describe('BOOT_CODE_LIST', () => {
  it('names every registry key once', () => {
    expect([...BOOT_CODE_LIST].sort()).toEqual(Object.keys(BOOT_CODES).sort());
    expect(new Set(BOOT_CODE_LIST).size).toBe(BOOT_CODE_LIST.length);
  });
});

describe('BOOT_SEVERITIES', () => {
  it('covers every severity a code uses', () => {
    const used = new Set(Object.values(BOOT_CODES).map((spec) => spec.severity));
    for (const severity of used) expect(BOOT_SEVERITIES).toContain(severity);
  });
});
