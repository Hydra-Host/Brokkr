import { describe, expect, it } from 'vitest';

import { fmtAgo, fmtBytes, fmtDeadline } from './format';

describe('fmtBytes', () => {
  it('strips a trailing .0 so telemetry reads 145 MB not 145.0 MB [medium-local-lab-web-fmtbytes-reimplemented-instead-of-importing-existing-uti]', () => {
    expect(fmtBytes(145 * 1024 * 1024)).toBe('145 MB');
  });

  it('keeps a fractional tenth', () => {
    expect(fmtBytes(1536)).toBe('1.5 KB');
  });

  it('guards non-finite and non-positive input with 0 B [medium-local-lab-web-fmtbytes-reimplemented-instead-of-importing-existing-uti]', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(-5)).toBe('0 B');
    expect(fmtBytes(Number.NaN)).toBe('0 B');
    expect(fmtBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});

describe('fmtDeadline', () => {
  const NOW = 1_700_000_000_000;

  it('reads a future deadline as time remaining, which fmtAgo clamps to zero', () => {
    expect(fmtDeadline(NOW + 240_000, NOW)).toBe('in 4m');
    expect(fmtAgo(NOW + 240_000, NOW)).toBe('0s ago');
  });

  it('reads a passed deadline as overdue rather than as time remaining', () => {
    expect(fmtDeadline(NOW - 120_000, NOW)).toBe('2m overdue');
  });

  it('reads the deadline itself as in 0s, not as overdue', () => {
    expect(fmtDeadline(NOW, NOW)).toBe('in 0s');
  });

  it('scales past minutes the same way an age does', () => {
    expect(fmtDeadline(NOW + 7_200_000, NOW)).toBe('in 2h');
    expect(fmtDeadline(NOW + 172_800_000, NOW)).toBe('in 2d');
  });
});
