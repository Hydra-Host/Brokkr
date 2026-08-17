import { Inject, Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import { ccBuildInfo, invalidateCcBuildHead } from '../common/build-info';
import type { BranchCheckoutResult, RepoBranch } from '../contract';
import { OverlayStoreService } from './overlay-store';

const execFileP = promisify(execFile);

@Injectable()
export class RepoBranchService {
  constructor(
    @Inject(OverlayStoreService) private readonly overlay: Pick<OverlayStoreService, 'hubRepoPathOverride'>,
  ) {}

  repoPath(): string | undefined {
    return this.overlay.hubRepoPathOverride() || process.env.HUB_REPO_PATH;
  }

  async branch(): Promise<RepoBranch> {
    const repoPath = this.repoPath();
    if (!repoPath) return { branch: null, error: 'repo path not configured' };
    if (!existsSync(repoPath)) return { branch: null, error: `repo path does not exist: ${repoPath}` };
    try {
      const { stdout } = await execFileP('git', ['-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        timeout: 5_000,
      });
      const head = stdout.trim();
      if (head === 'HEAD') return { branch: null, error: 'detached HEAD' };
      return { branch: head, error: null };
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      return { branch: null, error: (err.stderr || err.message || String(e)).trim() };
    }
  }

  async checkout(target: string): Promise<BranchCheckoutResult> {
    const nameError = this.safeBranchNameError(target);
    if (nameError) {
      const current = await this.branch();
      return this.withRebuildFlag({ branch: current.branch, error: `invalid branch name: ${nameError}` });
    }
    const repoPath = this.repoPath();
    if (!repoPath) return this.withRebuildFlag({ branch: null, error: 'repo path not configured' });
    if (!existsSync(repoPath)) {
      return this.withRebuildFlag({ branch: null, error: `repo path does not exist: ${repoPath}` });
    }
    const current = await this.branch();
    if (current.branch === target) return this.withRebuildFlag(current);
    const refExists = async (ref: string) => {
      try {
        await execFileP('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', ref], { timeout: 5_000 });
        return true;
      } catch {
        return false;
      }
    };
    try {
      if (await refExists(`refs/heads/${target}`)) {
        await execFileP('git', ['-C', repoPath, 'checkout', target, '--'], { timeout: 15_000 });
      } else if (await refExists(`refs/remotes/origin/${target}`)) {
        await execFileP('git', ['-C', repoPath, 'checkout', '-b', target, `origin/${target}`, '--'], {
          timeout: 15_000,
        });
      } else {
        await execFileP('git', ['-C', repoPath, 'checkout', '-b', target, '--'], { timeout: 15_000 });
      }
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      const after = await this.branch();
      return this.withRebuildFlag({ branch: after.branch, error: (err.stderr || err.message || String(e)).trim() });
    }
    return this.withRebuildFlag(await this.branch());
  }

  private async withRebuildFlag(result: RepoBranch): Promise<BranchCheckoutResult> {
    invalidateCcBuildHead();
    return { ...result, ccRebuildRequired: (await ccBuildInfo()).stale };
  }

  // reject refs git treats specially or that could smuggle a leading-dash option / pathspec into
  // checkout; the trailing `--` in checkout() is the paired guard against anything that slips through.
  private safeBranchNameError(target: string): string | null {
    if (target.length === 0) return 'empty';
    if (target.length > 200) return 'too long';
    if (target.startsWith('-')) return 'leading dash';
    if (/[\s\p{Cc}]/u.test(target)) return 'whitespace or control character';
    if (target.includes('..')) return 'contains ".."';
    if (target.includes('@{')) return 'contains "@{"';
    if (target.includes('\\')) return 'contains backslash';
    if (target.endsWith('/')) return 'trailing slash';
    if (target.endsWith('.lock')) return 'ends with ".lock"';
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(target)) return 'illegal characters';
    return null;
  }
}
