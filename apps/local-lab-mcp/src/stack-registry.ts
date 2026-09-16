import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
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

// primary checkout = parent of --git-common-dir (shared by every worktree). nested worktrees
// sit under that root; sibling worktrees share the common dir without sharing a path prefix.
const gitCommonDirByPath = new Map<string, string | null>();
let repoRoot: string | null | undefined;

function canonicalize(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function gitCommonDirOf(cwd: string): string | null {
  const key = canonicalize(cwd);
  const cached = gitCommonDirByPath.get(key);
  if (cached !== undefined) return cached;
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: key,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // git may print a realpath while we resolved a symlink (macOS /var → /private/var)
    const common = out ? canonicalize(resolve(key, out)) : null;
    gitCommonDirByPath.set(key, common);
    return common;
  } catch {
    gitCommonDirByPath.set(key, null);
    return null;
  }
}

export function repoRootOfCwd(): string | null {
  if (repoRoot !== undefined) return repoRoot;
  const common = gitCommonDirOf(process.cwd());
  repoRoot = common === null ? null : dirname(common);
  return repoRoot;
}

export function isSameRepoCheckout(checkout: string, root: string | null = repoRootOfCwd()): boolean {
  if (!root) return false;
  if (checkout === root || checkout.startsWith(`${root}${sep}`)) return true;
  const checkoutCommon = gitCommonDirOf(checkout);
  const rootCommon = gitCommonDirOf(root);
  return checkoutCommon !== null && checkoutCommon === rootCommon;
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
