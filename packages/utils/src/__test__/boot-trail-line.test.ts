import { describe, expect, it } from 'vitest';
import { type BootTrailInput } from '../boot-trail-findings';
import { bootTrailLine } from '../boot-trail-line';

const PXE_AT = Date.UTC(2026, 8, 16, 14, 2, 11);
const CHAIN_AT = PXE_AT + 8_000;
const trail = (over: Partial<BootTrailInput> = {}): BootTrailInput => ({
  pxe: null,
  chainReached: false,
  chainAtMs: null,
  readError: null,
  ...over,
});

describe('bootTrailLine', () => {
  it('names the read error', () => {
    expect(bootTrailLine(trail({ readError: 'ECONNREFUSED', chainReached: null }))).toBe(
      'boot trail unreadable: ECONNREFUSED',
    );
  });

  it('says no request was seen', () => {
    expect(bootTrailLine(trail())).toBe('no PXE request seen yet');
  });

  it('reports a chain hit with no request and no time', () => {
    expect(bootTrailLine(trail({ chainReached: true }))).toBe('iPXE chain reached, no PXE request recorded');
  });

  it('reports a chain hit with no request and its clock', () => {
    const line = bootTrailLine(trail({ chainReached: true, chainAtMs: CHAIN_AT }));
    expect(line).toMatch(/^iPXE chain reached at .+, no PXE request recorded$/);
  });

  it('names the decision and the missing chain', () => {
    const line = bootTrailLine(trail({ pxe: { outcome: 'offered', atMs: PXE_AT } }));
    expect(line).toContain('PXE offered at ');
    expect(line).toContain('; iPXE chain not reached yet');
  });

  it('reports a chain hit without a time', () => {
    expect(bootTrailLine(trail({ pxe: { outcome: 'offered', atMs: PXE_AT }, chainReached: true }))).toMatch(
      /; iPXE chain reached$/,
    );
  });

  it('reports a chain hit with its clock', () => {
    const line = bootTrailLine(
      trail({ pxe: { outcome: 'offered', atMs: PXE_AT }, chainReached: true, chainAtMs: CHAIN_AT }),
    );
    expect(line).toContain('; iPXE chain reached at ');
  });
});
