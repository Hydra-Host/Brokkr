import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const labRoot = join(import.meta.dirname, '..');

const stamp = { sha: null, builtAt: Date.now() };
try {
  stamp.sha = execFileSync('git', ['-C', labRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || null;
} catch {
  // a .git-less build context (tarball/CI) still gets a stamp; the runtime reads sha=null as "unknown"
}
writeFileSync(join(labRoot, 'dist', 'build-info.json'), `${JSON.stringify(stamp)}\n`);
console.log(`build-info.json: sha=${stamp.sha ?? 'unknown'}`);
