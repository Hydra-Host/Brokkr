import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => {
  const open = vi.fn();
  return { open, default: { open } };
});

vi.mock('../wipe', () => ({ waitForReadReady: vi.fn() }));

import { open as mockedOpen } from 'node:fs/promises';
import { classifyDiskWipe, classifyValidationResult, computeSampleSectors, validateWipe } from '.././validateWipe';
import { waitForReadReady } from '../wipe';

describe('computeSampleSectors', () => {
  const SAMPLE_COUNT = 1000;

  it('returns an empty list for disks smaller than 2× sampleCount', () => {
    expect(computeSampleSectors(1999)).toEqual([]);
  });

  it('returns an empty list when totalSectors is not finite', () => {
    expect(computeSampleSectors(Number.NaN)).toEqual([]);
    expect(computeSampleSectors(Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it('returns 1000 sectors for a disk exactly 2× sampleCount', () => {
    const result = computeSampleSectors(2000);
    expect(result).toHaveLength(SAMPLE_COUNT);
    expect(result[0]).toBe(100);
    expect(result[1]).toBe(101);
    expect(result[999]).toBe(1099);
  });

  it('matches the formula exactly for a large disk', () => {
    const total = 3_906_250_000;
    const step = Math.floor((total - 200) / SAMPLE_COUNT);
    const result = computeSampleSectors(total);
    expect(result).toHaveLength(SAMPLE_COUNT);
    expect(result[0]).toBe(100);
    expect(result[1]).toBe(100 + step);
    expect(result[999]).toBe(100 + 999 * step);
  });

  it('avoids the very first and last 100 sectors (GPT guard region)', () => {
    const total = 100_000;
    const result = computeSampleSectors(total);
    expect(result[0]).toBeGreaterThanOrEqual(100);
    expect(result[result.length - 1]!).toBeLessThan(total - 100);
  });

  it('is monotonically increasing', () => {
    const result = computeSampleSectors(10_000_000);
    for (let i = 1; i < result.length; i += 1) {
      expect(result[i]!).toBeGreaterThan(result[i - 1]!);
    }
  });

  it('honors a non-default sampleCount when provided', () => {
    const result = computeSampleSectors(100_000, 10);
    expect(result).toHaveLength(10);
    expect(result[0]).toBe(100);
    expect(result[1]).toBe(100 + 9980);
    expect(result[9]).toBe(100 + 9 * 9980);
  });
});

describe('classifyDiskWipe', () => {
  it('maps verification fail -> fail', () => {
    expect(
      classifyDiskWipe({ technique: 'dd urandom (best-effort)', validationResult: 'fail', isDevRotationalSkip: false }),
    ).toBe('fail');
  });

  it('maps verification pass -> pass (zeroize all-zero / overwrite differs)', () => {
    expect(
      classifyDiskWipe({
        technique: 'NVMe Sanitize Block Erase (Purge)',
        validationResult: 'pass',
        isDevRotationalSkip: false,
      }),
    ).toBe('pass');
  });

  it('maps verification pass_crypto_erase -> pass_crypto_erase', () => {
    expect(
      classifyDiskWipe({
        technique: 'NVMe Sanitize Crypto Erase (Purge)',
        validationResult: 'pass_crypto_erase',
        isDevRotationalSkip: false,
      }),
    ).toBe('pass_crypto_erase');
  });

  it('maps technique=unknown -> fail (no wipe method succeeded)', () => {
    expect(
      classifyDiskWipe({ technique: 'unknown', validationResult: 'not_validated', isDevRotationalSkip: false }),
    ).toBe('fail');
  });

  it('maps a succeeded-but-unverified wipe (not_validated) -> fail in any mode', () => {
    expect(
      classifyDiskWipe({
        technique: 'NVMe Sanitize Block Erase (Purge)',
        validationResult: 'not_validated',
        isDevRotationalSkip: false,
      }),
    ).toBe('fail');
  });

  it('exempts the dev-mode rotational skip: not_validated stays pass', () => {
    expect(
      classifyDiskWipe({
        technique: 'development zero-fill (first 1MB)',
        validationResult: 'not_validated',
        isDevRotationalSkip: true,
      }),
    ).toBe('pass');
  });

  it('still fails an unknown technique even on the dev rotational path', () => {
    expect(
      classifyDiskWipe({ technique: 'unknown', validationResult: 'not_validated', isDevRotationalSkip: true }),
    ).toBe('fail');
  });
});

describe('classifyValidationResult', () => {
  const cryptoEraseMethods = [
    'NVMe Sanitize Crypto Erase (Purge)',
    'NVMe Format SES=2 Crypto Erase (Purge)',
    'ATA Sanitize Crypto Scramble (Purge)',
  ];

  const overwriteMethods = [
    'NVMe Sanitize Block Erase (Purge)',
    'NVMe Format SES=1',
    'ATA Sanitize Block Erase (Purge)',
    'ATA Sanitize Overwrite (Purge)',
    'ATA Secure Erase Enhanced (Clear)',
    'ATA Secure Erase (Clear)',
    'blkdiscard (best-effort)',
    'dd urandom (best-effort)',
    'dd zero count=1 (development)',
  ];

  it('returns "pass" when there are zero failed sectors, regardless of method', () => {
    for (const m of [...cryptoEraseMethods, ...overwriteMethods]) {
      expect(classifyValidationResult(0, m)).toBe('pass');
    }
  });

  it('returns "pass_crypto_erase" when a crypto-erase method has residue', () => {
    for (const m of cryptoEraseMethods) {
      expect(classifyValidationResult(1, m)).toBe('pass_crypto_erase');
      expect(classifyValidationResult(999, m)).toBe('pass_crypto_erase');
    }
  });

  it('returns "fail" when an overwrite method has ANY residue', () => {
    for (const m of overwriteMethods) {
      expect(classifyValidationResult(1, m)).toBe('fail');
      expect(classifyValidationResult(42, m)).toBe('fail');
      expect(classifyValidationResult(999, m)).toBe('fail');
    }
  });

  it('unknown method names with residue classify as fail (safer default)', () => {
    expect(classifyValidationResult(1, 'unknown')).toBe('fail');
    expect(classifyValidationResult(5, '')).toBe('fail');
  });
});


describe('validateWipe — EIO threshold', () => {
  const DISK = 'sda';
  const SECTORS = Array.from({ length: 100 }, (_, i) => i + 100);
  const ZERO_METHOD_MARKERS = SECTORS.map((sector) => ({ sector, marker: 'ab'.repeat(512) }));

  function makeHandleStub(eioSectors: Set<number>) {
    const close = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn((buf: Buffer, _off: number, _len: number, position: number) => {
      const sector = position / 512;
      if (eioSectors.has(sector)) {
        const e = new Error('EIO');
        (e as NodeJS.ErrnoException).code = 'EIO';
        throw e;
      }
      buf.fill(0);
      return Promise.resolve({ bytesRead: 512, buffer: buf });
    });
    return { close, read };
  }

  beforeEach(() => {
    vi.mocked(mockedOpen).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries via waitForReadReady when open() raises EIO, then validates', async () => {
    const eioErr = Object.assign(new Error('EIO'), { code: 'EIO' });
    vi.mocked(waitForReadReady).mockResolvedValue(undefined);
    vi.mocked(mockedOpen)
      .mockRejectedValueOnce(eioErr)
      .mockResolvedValueOnce(makeHandleStub(new Set()) as never);

    const result = await validateWipe(DISK, ZERO_METHOD_MARKERS, 'NVMe Sanitize Block Erase (Purge)');

    expect(waitForReadReady).toHaveBeenCalledWith(DISK);
    expect(vi.mocked(mockedOpen)).toHaveBeenCalledTimes(2);
    expect(result.result).toBe('pass');
    expect(result.sectors_unreadable).toBe(0);
  });

  it('records the disk as fully unreadable (fail) when open() keeps raising EIO — never throws', async () => {
    const eioErr = Object.assign(new Error('EIO'), { code: 'EIO' });
    vi.mocked(waitForReadReady).mockResolvedValue(undefined);
    vi.mocked(mockedOpen).mockRejectedValue(eioErr);

    const result = await validateWipe(DISK, ZERO_METHOD_MARKERS, 'NVMe Sanitize Crypto Erase (Purge)');

    expect(result.result).toBe('fail');
    expect(result.sectors_unreadable).toBe(ZERO_METHOD_MARKERS.length);
    expect(result.sectors_zeroed).toBe(0);
  });

  it('fails fast on a non-EIO open() error without waiting for the restricted-read window', async () => {
    const enodev = Object.assign(new Error('no such device'), { code: 'ENODEV' });
    vi.mocked(waitForReadReady).mockResolvedValue(undefined);
    vi.mocked(mockedOpen).mockRejectedValue(enodev);

    const result = await validateWipe(DISK, ZERO_METHOD_MARKERS, 'NVMe Sanitize Crypto Erase (Purge)');

    expect(waitForReadReady).not.toHaveBeenCalled();
    expect(result.result).toBe('fail');
    expect(result.sectors_unreadable).toBe(ZERO_METHOD_MARKERS.length);
  });

  it('tolerates a handful of EIO sectors below the threshold (still pass)', async () => {
    const eio = new Set([100, 105, 110, 115, 120]);
    vi.mocked(mockedOpen).mockResolvedValue(makeHandleStub(eio) as never);

    const result = await validateWipe(DISK, ZERO_METHOD_MARKERS, 'NVMe Sanitize Block Erase (Purge)');

    expect(result.result).toBe('pass');
    expect(result.sectors_unreadable).toBe(5);
    expect(result.sectors_failed).toBe(0);
    expect(result.sectors_zeroed).toBe(95);
  });

  it('fails when unreadable sectors meet the threshold', async () => {
    const eio = new Set(Array.from({ length: 10 }, (_, i) => 100 + i));
    vi.mocked(mockedOpen).mockResolvedValue(makeHandleStub(eio) as never);

    const result = await validateWipe(DISK, ZERO_METHOD_MARKERS, 'NVMe Sanitize Block Erase (Purge)');

    expect(result.result).toBe('fail');
    expect(result.sectors_unreadable).toBe(10);
    expect(result.note).toMatch(/10\/100.*unreadable/);
  });

  it('fails on a dead drive that EIOs every sector (regression for old false pass)', async () => {
    const eio = new Set(SECTORS);
    vi.mocked(mockedOpen).mockResolvedValue(makeHandleStub(eio) as never);

    const result = await validateWipe(DISK, ZERO_METHOD_MARKERS, 'NVMe Sanitize Crypto Erase (Purge)');

    expect(result.result).toBe('fail');
    expect(result.sectors_unreadable).toBe(100);
    expect(result.sectors_zeroed).toBe(0);
  });

  it('fail override beats pass_crypto_erase when too many sectors are unreadable', async () => {
    const eio = new Set(Array.from({ length: 50 }, (_, i) => 100 + i));
    vi.mocked(mockedOpen).mockResolvedValue(makeHandleStub(eio) as never);

    const result = await validateWipe(DISK, ZERO_METHOD_MARKERS, 'NVMe Sanitize Crypto Erase (Purge)');

    expect(result.result).toBe('fail');
    expect(result.sectors_unreadable).toBe(50);
  });
});

describe('validateWipe — overwrite-class marker diff', () => {
  const DISK = 'sdb';
  const N = 100;
  const SECTORS = Array.from({ length: N }, (_, i) => i + 100);

  function markerBytes(sector: number): Buffer {
    return Buffer.alloc(512, (sector % 254) + 1);
  }
  const MARKERS = SECTORS.map((sector) => ({ sector, marker: markerBytes(sector).toString('hex') }));

  function makeHandleStub(readContent: (sector: number) => Buffer) {
    const close = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn((buf: Buffer, _off: number, _len: number, position: number) => {
      const sector = position / 512;
      readContent(sector).copy(buf);
      return Promise.resolve({ bytesRead: 512, buffer: buf });
    });
    return { close, read };
  }

  beforeEach(() => {
    vi.mocked(mockedOpen).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const method of ['Random data overwrite (Clear)', 'ATA Sanitize Overwrite (Purge)']) {
    it(`PASSES when every sector is overwritten with new non-zero data (${method})`, async () => {
      const overwritten = (sector: number) => Buffer.alloc(512, ((sector + 7) % 254) + 1);
      vi.mocked(mockedOpen).mockResolvedValue(makeHandleStub(overwritten) as never);

      const result = await validateWipe(DISK, MARKERS, method);

      expect(result.result).toBe('pass');
      expect(result.sectors_failed).toBe(0);
      expect(result.sectors_unreadable).toBe(0);
      expect(result.sectors_zeroed).toBe(0);
      expect(result.note).toMatch(/marker diff/i);
    });

    it(`PASSES even when overwritten data reads all-zero (${method})`, async () => {
      const zeros = () => Buffer.alloc(512, 0);
      vi.mocked(mockedOpen).mockResolvedValue(makeHandleStub(zeros) as never);

      const result = await validateWipe(DISK, MARKERS, method);

      expect(result.result).toBe('pass');
      expect(result.sectors_failed).toBe(0);
      expect(result.sectors_zeroed).toBe(N);
    });

    it(`FAILS when sectors still match their pre-wipe marker — not overwritten (${method})`, async () => {
      vi.mocked(mockedOpen).mockResolvedValue(makeHandleStub(markerBytes) as never);

      const result = await validateWipe(DISK, MARKERS, method);

      expect(result.result).toBe('fail');
      expect(result.sectors_failed).toBe(N);
      expect(result.note).toMatch(/still match their pre-wipe marker/i);
    });
  }

  it('FAILS partially-overwritten disk (some sectors still equal the marker)', async () => {
    const untouched = new Set(SECTORS.slice(0, 10));
    const content = (sector: number) =>
      untouched.has(sector) ? markerBytes(sector) : Buffer.alloc(512, ((sector + 7) % 254) + 1);
    vi.mocked(mockedOpen).mockResolvedValue(makeHandleStub(content) as never);

    const result = await validateWipe(DISK, MARKERS, 'Random data overwrite (Clear)');

    expect(result.result).toBe('fail');
    expect(result.sectors_failed).toBe(10);
  });

  it('a zeroing method (ATA Secure Erase) still requires all-zero reads', async () => {
    vi.mocked(mockedOpen).mockResolvedValue(makeHandleStub(markerBytes) as never);

    const result = await validateWipe(DISK, MARKERS, 'ATA Secure Erase Enhanced (Purge, legacy)');

    expect(result.result).toBe('fail');
    expect(result.sectors_failed).toBe(N);
  });
});
