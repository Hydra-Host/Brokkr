import { BillingFrequency } from '../enums';
import {
  capitalizeFirstLetter,
  convertSize,
  formatDemandRequestDeviceSpecs,
  formatDriveCountSize,
  formatDriveSizeGroups,
  formatMillisecondsToDuration,
  formatDuration,
  formatPriceFromCentsToDollars,
  formatReservationInvitePrice,
  formatSize,
  getHourlyOrInvitePrice,
  getUserInitials,
  getWeeklyOrInvitePrice,
  mibSizesToGib,
  normalizeGpuModel,
  parseSize,
  perDriveSizeGb,
} from '../format';

describe('capitalizeFirstLetter', () => {
  it('capitalizes the first letter of a word', () => {
    expect(capitalizeFirstLetter('hello')).toBe('Hello');
  });

  it('returns empty string for null or undefined', () => {
    expect(capitalizeFirstLetter(null)).toBe('');
    expect(capitalizeFirstLetter(undefined)).toBe('');
  });
});

describe('formatDuration', () => {
  it('returns an em dash for missing values', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
  });

  it('formats zero seconds as 0s', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('formats minutes and hours', () => {
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(3661)).toBe('1h 1m');
  });
});

describe('formatMillisecondsToDuration', () => {
  it('formats milliseconds as minutes', () => {
    expect(formatMillisecondsToDuration(120_000)).toBe('2 minutes');
  });

  it('formats milliseconds as hours', () => {
    expect(formatMillisecondsToDuration(7_200_000)).toBe('2 hours');
  });

  it('formats milliseconds as days', () => {
    expect(formatMillisecondsToDuration(172_800_000)).toBe('2 days');
  });

  it('uses singular form for 1 unit', () => {
    expect(formatMillisecondsToDuration(60_000)).toBe('1 minute');
    expect(formatMillisecondsToDuration(3_600_000)).toBe('1 hour');
    expect(formatMillisecondsToDuration(86_400_000)).toBe('1 day');
  });
});

describe('formatPriceFromCentsToDollars', () => {
  it('converts cents to formatted dollar string', () => {
    expect(formatPriceFromCentsToDollars(1000)).toBe('$10.00');
    expect(formatPriceFromCentsToDollars(150)).toBe('$1.50');
    expect(formatPriceFromCentsToDollars(0)).toBe('$0.00');
  });
});

describe('mibSizesToGib', () => {
  it('converts, rounds, and deduplicates MiB values', () => {
    expect(mibSizesToGib([1024, 1536, 2048, 2050])).toEqual([1, 2]);
  });
});

describe('convertSize', () => {
  it('defaults to bytes → GiB, the raw lsblk byte count into a storage column', () => {
    expect(convertSize(1024 ** 3)).toBe(1);
    expect(convertSize(3840n * 1024n ** 3n)).toBe(3840);
    expect(convertSize(500_000_000_000)).toBeCloseTo(465.661, 3);
  });

  it('steps by 1024 in both directions', () => {
    expect(convertSize(1024 ** 3, 'B', 'GB')).toBe(1);
    expect(convertSize(1, 'GB', 'B')).toBe(1024 ** 3);
    expect(convertSize(1024, 'MB', 'GB')).toBe(1);
  });

  it('is the identity for a same-unit conversion', () => {
    expect(convertSize(437, 'GB', 'GB')).toBe(437);
  });

  it('leaves rounding to the caller, who floors for identifiers and rounds for totals', () => {
    expect(convertSize(500_000_000_000, 'B', 'GB')).toBeCloseTo(465.661, 3);
  });

  it('accepts the bigint StorageDrive.sizeBytes carries', () => {
    expect(convertSize(3840n * 1024n ** 3n, 'B', 'GB')).toBe(3840);
  });
});

describe('formatSize', () => {
  it('steps by 1024, not 1000', () => {
    expect(formatSize(1024)).toBe('1 KB');
    expect(formatSize(1000)).toBe('1000 B');
  });

  it('scales through as many units as the magnitude needs', () => {
    expect(formatSize(1024 ** 2)).toBe('1 MB');
    expect(formatSize(1024 ** 3)).toBe('1 GB');
    expect(formatSize(1024 ** 4)).toBe('1 TB');
    expect(formatSize(1024 ** 5)).toBe('1 PB');
    expect(formatSize(1024 ** 6)).toBe('1 EB');
  });

  it('clamps at the largest known unit rather than inventing one', () => {
    expect(formatSize(1024 ** 8)).toBe('1048576 EB');
  });

  it('scales from whatever unit the value is already in', () => {
    expect(formatSize(3840, 'GB')).toBe('3.8 TB');
    expect(formatSize(98304, 'MB')).toBe('96 GB');
  });

  it('drops trailing zeros so whole values read cleanly', () => {
    expect(formatSize(2 * 1024 ** 3)).toBe('2 GB');
    expect(formatSize(1536 * 1024 ** 2, 'B', 2)).toBe('1.5 GB');
  });

  it('keeps integer zeros when asked for no decimals', () => {
    expect(formatSize(100, 'B', 0)).toBe('100 B');
    expect(formatSize(500, 'GB', 0)).toBe('500 GB');
  });

  it('returns null for nothing to show', () => {
    expect(formatSize(0)).toBeNull();
    expect(formatSize(null)).toBeNull();
    expect(formatSize(undefined)).toBeNull();
    expect(formatSize(-1)).toBeNull();
  });

  it('accepts the bigint StorageDrive.sizeBytes carries', () => {
    expect(formatSize(3840n * 1024n ** 3n)).toBe('3.8 TB');
  });
});

describe('formatDemandRequestDeviceSpecs', () => {
  it('joins gpu, cpu, and storage fragments', () => {
    expect(
      formatDemandRequestDeviceSpecs({
        gpuModel: 'H100',
        gpuCount: 8,
        cpuModel: 'EPYC',
        cpuCount: 2,
        cpuCoreCount: 64,
        memory: 512,
        ssdSize: 2000,
      }),
    ).toBe('8x H100, 2x EPYC (64 cores), 512 GB RAM, 1.95 TB SSD');
  });

  it('returns empty string when nothing is set', () => {
    expect(formatDemandRequestDeviceSpecs({})).toBe('');
  });
});

describe('parseSize', () => {
  it('parses number-with-unit strings on 1024 steps', () => {
    expect(parseSize('500 GB')).toBe(500 * 1024 ** 3);
    expect(parseSize('1.5TB')).toBe(1.5 * 1024 ** 4);
    expect(parseSize('512MB')).toBe(512 * 1024 ** 2);
  });

  it('tolerates case and surrounding whitespace', () => {
    expect(parseSize('500gb')).toBe(500 * 1024 ** 3);
    expect(parseSize('  1 tb  ')).toBe(1024 ** 4);
  });

  it('accepts binary-suffixed units as the same magnitude', () => {
    expect(parseSize('10 GiB')).toBe(10 * 1024 ** 3);
  });

  it('treats a bare number as bytes', () => {
    expect(parseSize('1048576')).toBe(1_048_576);
  });

  it('round-trips formatSize output', () => {
    expect(parseSize(formatSize(10 * 1024 ** 3)!)).toBe(10 * 1024 ** 3);
    expect(parseSize(formatSize(512 * 1024 ** 2)!)).toBe(512 * 1024 ** 2);
    expect(parseSize(formatSize(1.5 * 1024 ** 4)!)).toBe(1.5 * 1024 ** 4);
  });

  it('returns null for unparseable or non-positive input', () => {
    expect(parseSize('')).toBeNull();
    expect(parseSize('   ')).toBeNull();
    expect(parseSize('abc')).toBeNull();
    expect(parseSize('10 XB')).toBeNull();
    expect(parseSize('-5 GB')).toBeNull();
    expect(parseSize('0')).toBeNull();
    expect(parseSize('0 GB')).toBeNull();
    expect(parseSize('10 GB extra')).toBeNull();
    expect(parseSize(null)).toBeNull();
    expect(parseSize(undefined)).toBeNull();
  });
});

describe('perDriveSizeGb', () => {
  it('divides the type total across the drive count', () => {
    expect(perDriveSizeGb(2, 7680)).toBe(3840);
    expect(perDriveSizeGb(1, 3840)).toBe(3840);
  });

  it('rounds to whole GB for totals that do not divide evenly', () => {
    expect(perDriveSizeGb(3, 1000)).toBe(333);
  });

  it('returns null when either scalar is missing or zero', () => {
    expect(perDriveSizeGb(null, 7680)).toBeNull();
    expect(perDriveSizeGb(2, null)).toBeNull();
    expect(perDriveSizeGb(0, 7680)).toBeNull();
    expect(perDriveSizeGb(undefined, undefined)).toBeNull();
  });
});

describe('formatDriveCountSize', () => {
  it('renders the per-drive size, not the type total', () => {
    expect(formatDriveCountSize(2, 7680)).toBe('2 × 3.8 TB');
    expect(formatDriveCountSize(1, 480)).toBe('1 × 480 GB');
  });

  it('treats the 0/0 projectStorage returns for an absent type as empty', () => {
    expect(formatDriveCountSize(0, 0)).toBe('--');
  });

  it('defaults to a dash when there is nothing to render', () => {
    expect(formatDriveCountSize(null, null)).toBe('--');
    expect(formatDriveCountSize(undefined, undefined)).toBe('--');
  });

  it('honours a caller-supplied empty value so a view can own its own fallback', () => {
    expect(formatDriveCountSize(null, null, null)).toBeNull();
    expect(formatDriveCountSize(0, 0, '—')).toBe('—');
    expect(formatDriveCountSize(undefined, undefined, 'Unknown')).toBe('Unknown');
  });

  it('falls back to whichever half-populated scalar it has', () => {
    expect(formatDriveCountSize(2, null)).toBe('2');
    expect(formatDriveCountSize(null, 500)).toBe('500 GB');
  });
});

describe('formatDriveSizeGroups', () => {
  const ONE_TB = 1_000_204_886_016;
  const FOUR_TB = 3_840_755_982_336;

  it('renders a group per capacity instead of averaging a mixed set into drives the host lacks', () => {
    expect(formatDriveSizeGroups([FOUR_TB, ONE_TB, FOUR_TB, ONE_TB])).toBe('2 × 931.5 GB; 2 × 3.5 TB');
  });

  it('collapses a uniform set into one group', () => {
    expect(formatDriveSizeGroups([ONE_TB, ONE_TB])).toBe('2 × 931.5 GB');
  });

  it('groups on the rendered size, so the same nominal drive a few blocks apart stays one group', () => {
    expect(formatDriveSizeGroups([ONE_TB, ONE_TB + 8192])).toBe('2 × 931.5 GB');
  });

  it('accepts the wire form of a BigInt column', () => {
    expect(formatDriveSizeGroups([String(ONE_TB), String(ONE_TB)])).toBe('2 × 931.5 GB');
  });

  it('ignores sizes that carry no fact', () => {
    expect(formatDriveSizeGroups([0, -1, Number.NaN])).toBe('--');
    expect(formatDriveSizeGroups([])).toBe('--');
    expect(formatDriveSizeGroups([], null)).toBeNull();
  });
});

describe('getUserInitials', () => {
  it('returns initials from full name', () => {
    expect(getUserInitials('John Doe')).toBe('JD');
  });

  it('returns single initial for single name', () => {
    expect(getUserInitials('John')).toBe('J');
  });
});

describe('normalizeGpuModel', () => {
  it('strips NVIDIA prefixes and lowercases', () => {
    expect(normalizeGpuModel('NVIDIA GeForce RTX 4090')).toBe('rtx 4090');
    expect(normalizeGpuModel('NVIDIA A100')).toBe('a100');
  });
});

describe('reservation invite price redaction', () => {
  const makeInvite = (price: number | null) => ({
    price,
    billingFrequency: BillingFrequency.WEEKLY,
  });

  const listing = {
    specs: { gpu: { count: 1 } },
    listing: {
      isInterruptibleOnly: false,
      interruptiblePrice: { perWeek: { total: 50000 }, perHour: { perGpu: null, total: 300 } },
      onDemandPrice: { perWeek: { total: 100000 }, perHour: { perGpu: null, total: 600 } },
    },
  };

  describe('formatReservationInvitePrice', () => {
    it("returns 'Price unavailable' when price is redacted to null", () => {
      expect(formatReservationInvitePrice(makeInvite(null), 1)).toBe('Price unavailable');
    });

    it('formats the per-hour invite price when price is present', () => {
      expect(formatReservationInvitePrice(makeInvite(168000), 1)).toBe('$10.00');
    });
  });

  it('getWeeklyOrInvitePrice falls back to the listing weekly price when price is redacted', () => {
    expect(getWeeklyOrInvitePrice(listing, false, makeInvite(null))).toBe('$1,000.00');
    expect(getWeeklyOrInvitePrice(listing, false, makeInvite(42000))).toBe('$420.00');
  });

  it('getHourlyOrInvitePrice falls back to the listing hourly price when price is redacted', () => {
    expect(getHourlyOrInvitePrice(listing, false, makeInvite(null))).toBe('$6.00');
    expect(getHourlyOrInvitePrice(listing, false, makeInvite(168000))).toBe('$10.00');
  });
});
