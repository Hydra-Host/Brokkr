import { describe, expect, it } from 'vitest';
import { BOOT_CODES } from '../boot-codes';
import { PREFIX_FINDING_CODES, TRAIL_BOOT_CODES, trailFindings, type BootTrailInput } from '../boot-trail-findings';

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);
const trail = (over: Partial<BootTrailInput> = {}): BootTrailInput => ({
  pxe: null,
  chainReached: false,
  chainAtMs: null,
  readError: null,
  ...over,
});
const expected = { bootExpectedSinceMs: NOW - 10 * 60_000, graceMs: 3 * 60_000, nowMs: NOW };
const notExpected = { bootExpectedSinceMs: null, graceMs: 3 * 60_000, nowMs: NOW };
const labRule = { bootExpectedSinceMs: 0, graceMs: 0, nowMs: NOW };

describe('trailFindings', () => {
  it('reports PXE-107 when the trail could not be read', () => {
    const findings = trailFindings(trail({ readError: 'ECONNREFUSED', chainReached: null }), 'cpu-1', expected);
    expect(findings.map((f) => f.code)).toEqual(['PXE-107']);
    expect(findings[0]?.message).toContain('ECONNREFUSED');
  });

  it('is silent about silence when no boot is expected', () => {
    expect(trailFindings(trail(), 'cpu-1', notExpected)).toEqual([]);
  });

  it('reports PXE-111 when a boot is expected and the grace period passed', () => {
    expect(trailFindings(trail(), 'cpu-1', expected).map((f) => f.code)).toEqual(['PXE-111']);
  });

  it('stays quiet inside the grace period', () => {
    expect(trailFindings(trail(), 'cpu-1', { ...expected, bootExpectedSinceMs: NOW - 60_000 })).toEqual([]);
  });

  it('reports PXE-111 when the last request predates the expected boot', () => {
    const findings = trailFindings(trail({ pxe: { outcome: 'offered', atMs: NOW - 60 * 60_000 } }), 'cpu-1', expected);
    expect(findings.map((f) => f.code)).toEqual(['PXE-111']);
    expect(findings[0]?.message).toContain('predates');
  });

  it('reports nothing when the chain was reached after the expected boot with no request', () => {
    const booted = trail({ chainReached: true, chainAtMs: NOW - 5 * 60_000 });
    expect(trailFindings(booted, 'cpu-1', expected)).toEqual([]);
    expect(trailFindings(booted, 'cpu-1', labRule)).toEqual([]);
  });

  it('does not call a stale request silence when the chain was reached after the expected boot', () => {
    const stale = trail({
      pxe: { outcome: 'offered', atMs: NOW - 60 * 60_000 },
      chainReached: true,
      chainAtMs: NOW - 5 * 60_000,
    });
    expect(trailFindings(stale, 'cpu-1', expected)).toEqual([]);
  });

  it('reports PXE-111 when the chain hit predates the expected boot', () => {
    const findings = trailFindings(trail({ chainReached: true, chainAtMs: NOW - 60 * 60_000 }), 'cpu-1', expected);
    expect(findings.map((f) => f.code)).toEqual(['PXE-111']);
  });

  it('reports PXE-111 when only the marker proves the chain hit', () => {
    expect(trailFindings(trail({ chainReached: true }), 'cpu-1', expected).map((f) => f.code)).toEqual(['PXE-111']);
  });

  it('maps refused-allowlist to PXE-110 and no-subnet to PXE-102', () => {
    const at = NOW - 60_000;
    expect(
      trailFindings(trail({ pxe: { outcome: 'refused-allowlist', atMs: at } }), 'cpu-1', expected).map((f) => f.code),
    ).toEqual(['PXE-110']);
    expect(
      trailFindings(trail({ pxe: { outcome: 'no-subnet', atMs: at } }), 'cpu-1', expected).map((f) => f.code),
    ).toEqual(['PXE-102']);
  });

  it('reports nothing for an offered request inside the window', () => {
    expect(trailFindings(trail({ pxe: { outcome: 'offered', atMs: NOW - 60_000 } }), 'cpu-1', expected)).toEqual([]);
  });

  it('keeps the lab rule when bootExpectedSinceMs is zero', () => {
    expect(trailFindings(trail(), 'cpu-1', labRule).map((f) => f.code)).toEqual(['PXE-111']);
  });

  it('reads every severity from the registry', () => {
    const at = NOW - 60_000;
    const cases: BootTrailInput[] = [
      trail({ readError: 'x', chainReached: null }),
      trail(),
      trail({ pxe: { outcome: 'refused-allowlist', atMs: at } }),
      trail({ pxe: { outcome: 'no-subnet', atMs: at } }),
    ];
    for (const c of cases) {
      for (const f of trailFindings(c, 'cpu-1', expected)) expect(f.severity).toBe(BOOT_CODES[f.code].severity);
    }
    expect(Object.values(TRAIL_BOOT_CODES).sort()).toEqual(['PXE-102', 'PXE-107', 'PXE-110', 'PXE-111']);
  });

  it('pins the prefix-scoped codes', () => {
    expect(PREFIX_FINDING_CODES).toEqual(['PXE-102', 'PXE-103', 'PXE-104', 'PXE-112', 'PXE-04']);
  });
});
