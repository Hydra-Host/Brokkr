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
});
