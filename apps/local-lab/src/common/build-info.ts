import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

import type { CcBuild } from '../contract';

const execFileP = promisify(execFile);

const labRoot = join(__dirname, '..', '..');

const BuildStampSchema = z.object({ sha: z.string().nullable(), builtAt: z.number().nullable() });

// a rebuild also restarts the API, so the stamp is process-static; only the live head needs a TTL.
const HEAD_TTL_MS = 5_000;

let stampCache: Promise<{ sha: string | null; builtAt: number | null }> | null = null;
let headCache: { at: number; sha: string | null } | null = null;

async function gitHead(): Promise<string | null> {
  const { stdout } = await execFileP('git', ['-C', labRoot, 'rev-parse', 'HEAD'], { timeout: 2_000 });
  return stdout.trim() || null;
}

function distMtime(): number | null {
  try {
    return Math.round(statSync(join(labRoot, 'dist', 'main.js')).mtimeMs);
  } catch {
    return null;
  }
}

function loadStamp(): Promise<{ sha: string | null; builtAt: number | null }> {
  if (!stampCache) {
    stampCache = (async () => {
      try {
        const stampPath = join(labRoot, 'dist', 'build-info.json');
        const stamp = BuildStampSchema.parse(JSON.parse(readFileSync(stampPath, 'utf8')));
        // `nest start --watch` recompiles main.js without rewriting the stamp — treat a stamp
        // older than the bundle it supposedly describes as absent.
        if (statSync(join(labRoot, 'dist', 'main.js')).mtimeMs > statSync(stampPath).mtimeMs) {
          throw new Error('stamp predates dist/main.js');
        }
        return stamp;
      } catch {
        // dev watch builds write no stamp — degrade to HEAD-at-start + bundle mtime
        return { sha: await gitHead().catch(() => null), builtAt: distMtime() };
      }
    })();
  }
  return stampCache;
}

async function liveHead(): Promise<string | null> {
  const now = Date.now();
  if (headCache && now - headCache.at < HEAD_TTL_MS) return headCache.sha;
  const sha = await gitHead().catch(() => null);
  headCache = { at: now, sha };
  return sha;
}

export async function ccBuildInfo(): Promise<CcBuild> {
  const [stamp, headSha] = await Promise.all([loadStamp(), liveHead()]);
  return {
    sha: stamp.sha,
    builtAt: stamp.builtAt,
    headSha,
    stale: stamp.sha !== null && headSha !== null && stamp.sha !== headSha,
  };
}

export function invalidateCcBuildHead(): void {
  headCache = null;
}

export function resetCcBuildCaches(): void {
  stampCache = null;
  headCache = null;
}
