import { relative, sep } from 'node:path';
import {
  findEntryBySlot,
  hostStackCandidates,
  isSameRepoCheckout,
  labPortOf,
  labUrlForPort,
  repoRootOfCwd,
  type StackCandidate,
} from './stack-registry.js';

// 'registry' is this checkout's own slot and 'explicit' is the test kit — every other source
// points somewhere this checkout does not own, which is what `own` gates the announce on.
export type TargetSource = 'explicit' | 'tool' | 'env-url' | 'env-slot' | 'registry';

export interface LabTarget {
  baseUrl: string;
  slot: number | null;
  checkout: string | null;
  sameRepo: boolean;
  source: TargetSource;
  own: boolean;
}

export const RETARGET_HINT = 'call lab_use_stack {"slot": N} to drive one of them';

export function describeCheckout(checkout: string, root: string | null = repoRootOfCwd()): string {
  if (!root || !isSameRepoCheckout(checkout, root)) return checkout;
  return checkout === root ? '.' : relative(root, checkout);
}

export function describeCandidates(candidates: StackCandidate[], root?: string | null): string {
  return candidates
    .map((candidate) => {
      const where = describeCheckout(candidate.checkout, root === undefined ? repoRootOfCwd() : root);
      const port = candidate.labPort === null ? 'no lab port yet' : `lab ${candidate.labPort}`;
      const repo = candidate.sameRepo ? 'same repo' : 'other clone';
      return `  slot ${candidate.slot}  ${where}  ${candidate.live ? 'live' : 'down'}, ${repo}, ${port}`;
    })
    .join('\n');
}

export function describeTarget(target: LabTarget): string {
  if (target.slot === null || target.checkout === null) return `[lab: ${target.baseUrl}]`;
  return `[lab: slot ${target.slot} · ${describeCheckout(target.checkout)}]`;
}

function noStacksError(): Error {
  return new Error('no stacks are registered on this host; run `task up` in a checkout first');
}

function candidateListing(candidates: StackCandidate[]): string {
  return `stacks on this host:\n${describeCandidates(candidates)}`;
}

function targetFromSlot(slot: number, source: TargetSource, registryDir?: string): LabTarget {
  const entry = findEntryBySlot(slot, registryDir);
  if (!entry) {
    const candidates = hostStackCandidates(registryDir);
    if (candidates.length === 0) throw noStacksError();
    throw new Error(`no stack is registered on slot ${slot}\n${candidateListing(candidates)}`);
  }
  const port = labPortOf(entry);
  if (port === null) {
    throw new Error(
      `slot ${slot} (${describeCheckout(entry.checkout)}) records no lab port yet — the stack is ` +
        'between its slot claim and its first supervisor stamp; retry once `task up` finishes there',
    );
  }
  return {
    baseUrl: labUrlForPort(port),
    slot,
    checkout: entry.checkout,
    sameRepo: isSameRepoCheckout(entry.checkout),
    source,
    own: false,
  };
}

// a name only ever matches a same-repo checkout. reaching another clone needs its slot number, so
// a loose name can never land on one by accident.
function targetFromName(name: string, registryDir?: string): LabTarget {
  const candidates = hostStackCandidates(registryDir);
  if (candidates.length === 0) throw noStacksError();
  const needle = name.toLowerCase();
  const matches = candidates.filter(
    (candidate) =>
      candidate.sameRepo &&
      (candidate.checkout.toLowerCase().includes(needle) ||
        candidate.checkout.split(sep).pop()?.toLowerCase() === needle),
  );
  if (matches.length === 0) {
    throw new Error(
      `no checkout of this repository matches '${name}'\n${candidateListing(candidates)}\n` +
        'a checkout of another clone is reachable by its slot number only',
    );
  }
  if (matches.length > 1) {
    throw new Error(`'${name}' matches more than one checkout\n${candidateListing(matches)}`);
  }
  const slot = matches[0]?.slot;
  if (slot === undefined) throw new Error(`no checkout of this repository matches '${name}'`);
  return targetFromSlot(slot, 'tool', registryDir);
}

export function selectStackTarget(args: { slot?: number; checkout?: string }, registryDir?: string): LabTarget {
  if (args.slot !== undefined && args.checkout !== undefined) {
    throw new Error('pass slot or checkout, not both');
  }
  if (args.slot !== undefined) return targetFromSlot(args.slot, 'tool', registryDir);
  if (args.checkout !== undefined) return targetFromName(args.checkout, registryDir);
  throw new Error('pass slot or checkout');
}

export function slotTargetFromEnv(registryDir?: string): LabTarget | null {
  const raw = process.env.LAB_MCP_SLOT?.trim();
  if (!raw) return null;
  const slot = Number.parseInt(raw, 10);
  if (!Number.isInteger(slot) || String(slot) !== raw) {
    throw new Error(`LAB_MCP_SLOT is not a slot number: ${raw}`);
  }
  return targetFromSlot(slot, 'env-slot', registryDir);
}
