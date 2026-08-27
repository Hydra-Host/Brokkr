import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import labUtilsPkg from './lab-utils.js';

const { getErrorMessage, isRecord } = labUtilsPkg;

const StackEntrySchema = z
  .object({
    slot: z.number(),
    checkout: z.string(),
    pcSock: z.string().optional(),
    pcDaemonPid: z.number().optional(),
    state: z.string().optional(),
    ports: z.object({ lab: z.number().optional() }).passthrough().optional(),
  })
  .passthrough();

export type StackEntry = z.infer<typeof StackEntrySchema>;

// mirrored by src/stack-registry.parity.test.ts against the lab-side reader; changing either rule
// without the other silently splits the two views of the same registry.
export const ENTRY_FILENAME_PATTERN = /^stack-\d+\.json$/;

export function defaultRegistryDir(): string {
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'brokkr-local', 'stacks');
}

// no liveness probing: a stale entry is the claim GC's problem, and probing would make every read
// tool spawn a subprocess.
export function readStackRegistry(dir: string = defaultRegistryDir()): StackEntry[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => ENTRY_FILENAME_PATTERN.test(file));
  } catch {
    return [];
  }
  const entries: StackEntry[] = [];
  for (const file of files) {
    try {
      const parsed = StackEntrySchema.safeParse(JSON.parse(readFileSync(join(dir, file), 'utf8')));
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'invalid entry');
      entries.push(parsed.data);
    } catch (error) {
      // stderr only — stdout is the MCP stdio wire
      console.error(`ignoring unparseable registry entry ${file}: ${getErrorMessage(error)}`);
    }
  }
  return entries.sort((a, b) => a.slot - b.slot);
}

export function findEntryByCheckout(checkout: string, dir?: string): StackEntry | null {
  return readStackRegistry(dir).find((entry) => entry.checkout === checkout) ?? null;
}

export function findEntryBySlot(slot: number, dir?: string): StackEntry | null {
  return readStackRegistry(dir).find((entry) => entry.slot === slot) ?? null;
}

export function labPortOf(entry: StackEntry): number | null {
  return typeof entry.ports?.lab === 'number' ? entry.ports.lab : null;
}

export function labBaseUrlForCheckout(checkout: string, dir?: string): string | null {
  const entry = findEntryByCheckout(checkout, dir);
  const port = entry && labPortOf(entry);
  return typeof port === 'number' ? labUrlForPort(port) : null;
}

export function labUrlForPort(port: number): string {
  return `http://127.0.0.1:${port}`;
}

// EPERM means the pid exists under another uid, which is alive. pid 0 is the window between the
// slot claim and the first refresh-pid stamp, so it must never read as dead.
export function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  if (pid === 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === 'EPERM';
  }
}

// the primary checkout and all of its worktrees share one --git-common-dir, so its parent is what
// tells a sibling worktree apart from an unrelated clone. one subprocess, memoized.
let repoRoot: string | null | undefined;

export function repoRootOfCwd(): string | null {
  if (repoRoot !== undefined) return repoRoot;
  repoRoot = null;
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // git prints this relative to the working directory at the toplevel and absolute elsewhere
    if (out) repoRoot = dirname(resolve(process.cwd(), out));
  } catch {
    // outside a checkout nothing counts as a sibling
  }
  return repoRoot;
}

export function isSameRepoCheckout(checkout: string, root: string | null = repoRootOfCwd()): boolean {
  if (!root) return false;
  return checkout === root || checkout.startsWith(`${root}${sep}`);
}

export interface StackCandidate {
  slot: number;
  checkout: string;
  labPort: number | null;
  live: boolean;
  state: string | null;
  sameRepo: boolean;
}

export function hostStackCandidates(dir?: string, root?: string | null): StackCandidate[] {
  const repo = root === undefined ? repoRootOfCwd() : root;
  return readStackRegistry(dir).map((entry) => ({
    slot: entry.slot,
    checkout: entry.checkout,
    labPort: labPortOf(entry),
    live: pidAlive(entry.pcDaemonPid),
    state: typeof entry.state === 'string' ? entry.state : null,
    sameRepo: isSameRepoCheckout(entry.checkout, repo),
  }));
}
