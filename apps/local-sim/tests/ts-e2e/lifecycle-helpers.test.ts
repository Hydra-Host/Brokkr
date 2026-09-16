import { describe, expect, it } from 'vitest';

import { formatBootTrailLine } from './lab-boot-trail';
import { osReturnTimeoutMs } from './lifecycle-helpers';

describe('osReturnTimeoutMs', () => {
  it('gives bare metal 900 s and a vm 240 s', () => {
    expect(osReturnTimeoutMs(true)).toBe(900_000);
    expect(osReturnTimeoutMs(false)).toBe(240_000);
  });
});

describe('formatBootTrailLine', () => {
  it('names the chain hit time', () => {
    expect(
      formatBootTrailLine({
        pxe: { outcome: 'chain', atMs: Date.parse('2026-09-12T10:00:00.000Z') },
        chainReached: true,
        chainAtMs: Date.parse('2026-09-12T10:00:07.000Z'),
        readError: null,
      }),
    ).toBe('PXE chain at 2026-09-12T10:00:00.000Z; iPXE chain reached at 2026-09-12T10:00:07.000Z');
  });

  it('says the chain was reached without a time when none was recorded', () => {
    expect(
      formatBootTrailLine({
        pxe: { outcome: 'chain', atMs: Date.parse('2026-09-12T10:00:00.000Z') },
        chainReached: true,
        chainAtMs: null,
        readError: null,
      }),
    ).toBe('PXE chain at 2026-09-12T10:00:00.000Z; iPXE chain reached');
  });

  it('says the chain was not reached', () => {
    expect(
      formatBootTrailLine({
        pxe: { outcome: 'offered', atMs: Date.parse('2026-09-12T10:00:00.000Z') },
        chainReached: false,
        chainAtMs: null,
        readError: null,
      }),
    ).toBe('PXE offered at 2026-09-12T10:00:00.000Z; iPXE chain not reached');
  });

  it('says no pxe request was seen', () => {
    expect(formatBootTrailLine({ pxe: null, chainReached: null, chainAtMs: null, readError: null })).toBe(
      'no PXE request seen',
    );
  });

  it('names a read error', () => {
    expect(
      formatBootTrailLine({
        pxe: { outcome: 'chain', atMs: Date.parse('2026-09-12T10:00:00.000Z') },
        chainReached: true,
        chainAtMs: Date.parse('2026-09-12T10:00:07.000Z'),
        readError: 'dhcp log unreadable: EACCES',
      }),
    ).toBe('boot trail unreadable: dhcp log unreadable: EACCES');
  });
});
