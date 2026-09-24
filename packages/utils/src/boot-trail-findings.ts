import { type BootCode, type BootFinding, bootCodeSpec } from './boot-codes';

export const PXE_OUTCOMES = ['offered', 'refused-allowlist', 'no-subnet'] as const;
export type PxeOutcome = (typeof PXE_OUTCOMES)[number];

export interface BootTrailInput {
  pxe: { outcome: PxeOutcome; atMs: number } | null;
  chainReached: boolean | null;
  chainAtMs: number | null;
  readError: string | null;
}

export interface TrailFindingOptions {
  /** null: no network boot is expected, so silence is not a finding. 0: always expected, the lab's rule. */
  bootExpectedSinceMs: number | null;
  graceMs: number;
  nowMs?: number;
}

export const TRAIL_BOOT_CODES = {
  unevaluated: 'PXE-107',
  noSubnet: 'PXE-102',
  refused: 'PXE-110',
  silent: 'PXE-111',
} as const satisfies Record<string, BootCode>;

/** Codes scoped to one hub prefix; the web app links these to the prefix DHCP settings page. */
export const PREFIX_FINDING_CODES: readonly BootCode[] = ['PXE-102', 'PXE-103', 'PXE-104', 'PXE-112', 'PXE-04'];

const iso = (ms: number): string => new Date(ms).toISOString();

function finding(code: BootCode, message: string): BootFinding {
  return { code, severity: bootCodeSpec(code).severity, message };
}

// keyed off the outcome union, so a new bridge decision is a compile error rather than a silent pass
const DECIDED: Record<PxeOutcome, ((subject: string, at: string) => BootFinding) | null> = {
  offered: null,
  'refused-allowlist': (subject, at) =>
    finding(
      TRAIL_BOOT_CODES.refused,
      `The bridge refused the PXE request from ${subject} at ${at}: its MAC is not in the proxy allowlist.`,
    ),
  'no-subnet': (subject, at) =>
    finding(
      TRAIL_BOOT_CODES.noSubnet,
      `The bridge had no DHCP subnet to answer the PXE request from ${subject} at ${at}.`,
    ),
};

export function trailFindings(trail: BootTrailInput, subject: string, options: TrailFindingOptions): BootFinding[] {
  if (trail.readError !== null) {
    return [
      finding(TRAIL_BOOT_CODES.unevaluated, `The PXE trail for ${subject} could not be read (${trail.readError}).`),
    ];
  }
  const since = options.bootExpectedSinceMs;
  const now = options.nowMs ?? Date.now();
  const expected = since !== null && now >= since + options.graceMs;
  // a chain hit at or after the expected boot proves the boot happened, whatever the bridge decided
  const booted = since !== null && trail.chainAtMs !== null && trail.chainAtMs >= since;
  if (trail.pxe === null) {
    if (since === null || !expected || booted) return [];
    return [
      finding(
        TRAIL_BOOT_CODES.silent,
        `No PXE request from ${subject} has reached the bridge since a network boot was expected at ${iso(since)}.`,
      ),
    ];
  }
  if (since !== null && expected && !booted && trail.pxe.atMs < since) {
    return [
      finding(
        TRAIL_BOOT_CODES.silent,
        `The last PXE request from ${subject} at ${iso(trail.pxe.atMs)} predates the network boot expected at ${iso(since)}.`,
      ),
    ];
  }
  const decided = DECIDED[trail.pxe.outcome];
  return decided === null ? [] : [decided(subject, iso(trail.pxe.atMs))];
}
