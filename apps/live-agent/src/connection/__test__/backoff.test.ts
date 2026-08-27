import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Backoff } from '.././backoff';

describe('Backoff', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('respects the configured base when random rolls 0 (full-jitter lower edge, no floor)', () => {
    (Math.random as ReturnType<typeof vi.fn>).mockReturnValue(0);
    const b = new Backoff({ initial_ms: 1_000, max_ms: 10_000 });
    expect(b.next()).toBe(0);
  });

  it('clamps the full-jitter lower edge up to min_ms when configured (no ~0ms reconnect)', () => {
    (Math.random as ReturnType<typeof vi.fn>).mockReturnValue(0);
    const b = new Backoff({ initial_ms: 1_000, max_ms: 10_000, min_ms: 1_000 });
    expect(b.next()).toBe(1_000);
  });

  it('holds the min_ms floor across successive attempts when random rolls 0', () => {
    (Math.random as ReturnType<typeof vi.fn>).mockReturnValue(0);
    const b = new Backoff({ initial_ms: 2_000, max_ms: 8_000, min_ms: 1_600 });
    expect(b.next()).toBe(1_600);
    expect(b.next()).toBe(1_600);
    expect(b.next()).toBe(1_600);
  });

  it('min_ms only raises the lower edge — values above the floor still jitter', () => {
    (Math.random as ReturnType<typeof vi.fn>).mockReturnValue(0.5);
    const b = new Backoff({ initial_ms: 1_000, max_ms: 60_000, min_ms: 250 });
    expect(b.next()).toBe(500);
  });

  it('respects the max_ms cap on the exponential growth', () => {
    (Math.random as ReturnType<typeof vi.fn>).mockReturnValue(0.999_999);
    const b = new Backoff({ initial_ms: 1, max_ms: 500 });
    for (let i = 0; i < 20; i += 1) b.next();
    expect(b.next()).toBeLessThan(500);
  });

  it('grows monotonically (in expectation) once out of the floor region', () => {
    (Math.random as ReturnType<typeof vi.fn>).mockReturnValue(0.5);
    const b = new Backoff({ initial_ms: 1_000, max_ms: 60_000 });
    const a = b.next();
    const c = b.next();
    const d = b.next();
    expect(a).toBe(500);
    expect(c).toBe(1_000);
    expect(d).toBe(2_000);
  });

  it('reset() returns the sequence to attempt 0', () => {
    (Math.random as ReturnType<typeof vi.fn>).mockReturnValue(0.5);
    const b = new Backoff({ initial_ms: 1_000, max_ms: 60_000 });
    b.next();
    b.next();
    b.next();
    b.reset();
    expect(b.next()).toBe(500);
  });

  it('factor:4 reproduces the original base-4 exponential growth (initial→max in one step)', () => {
    // With initial_ms=2000, max_ms=8000, factor=4:
    //   attempt 0: min(8000, 2000 * 4^0) = 2000  → random*2000
    //   attempt 1: min(8000, 2000 * 4^1) = 8000  → random*8000
    // Without factor (default 2):
    //   attempt 1: min(8000, 2000 * 2^1) = 4000  → random*4000  (the bug)
    (Math.random as ReturnType<typeof vi.fn>).mockReturnValue(0.999_999);
    const b = new Backoff({ initial_ms: 2_000, max_ms: 8_000, min_ms: 1_600, factor: 4 });
    b.next(); // attempt 0: base = 2_000
    const secondRetry = b.next(); // attempt 1: base should be 8_000, not 4_000
    expect(secondRetry).toBeGreaterThan(4_000);
  });

});
