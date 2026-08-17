import { Injectable } from '@nestjs/common';

import { PORTS } from '../ports';
import { RunnerService } from '../runner/runner.service';
import { OverlayStoreService } from '../services/overlay-store';
import { RepoBranchService } from '../services/repo-branch.service';

@Injectable()
export class BuildService {
  constructor(
    private readonly runner: RunnerService,
    private readonly overlay: OverlayStoreService,
    private readonly repoBranch: RepoBranchService,
  ) {}

  /** Run after edits under `agent/src/` — otherwise brokkr-live ships a stale main.js. */
  buildAgent(): string {
    const run = this.runner.create({ section: 'build', opId: 'build-agent', label: 'agent + initrd' });
    void (async () => {
      const repoPath = this.repoBranch.repoPath() ?? '';
      if (!repoPath) {
        this.runner.emit(run, '[build] HUB_REPO_PATH not set in lab environment — aborting\n');
        this.runner.finalize(run, 1);
        return;
      }
      this.runner.emit(run, `[build] repo=${repoPath}\n`);
      const steps: Array<{ label: string; cmd: string; args: string[]; cwd?: string }> = [
        {
          label: 'pnpm --filter @repo/bridge-agent-protocol build',
          cmd: 'pnpm',
          args: ['--filter', '@repo/bridge-agent-protocol', 'build'],
          cwd: repoPath,
        },
        {
          label: 'pnpm --filter bridge-agent build',
          cmd: 'pnpm',
          args: ['--filter', 'bridge-agent', 'build'],
          cwd: repoPath,
        },
        {
          label: 'live_initrd (cpio pack bridge-agent.img + brokkr-live.img)',
          cmd: 'python',
          args: ['-m', 'local.live_initrd'],
        },
      ];
      for (const s of steps) {
        this.runner.emit(run, `\n[build] ${s.label}\n`);
        const code = await this.runner.spawn(run, s.cmd, s.args, {}, s.cwd ? { cwd: s.cwd } : {});
        if (code !== 0) {
          this.runner.emit(run, `[build] step failed (exit=${code})\n`);
          this.runner.finalize(run, code);
          return;
        }
      }
      this.runner.finalize(run, 0);
    })();
    return run.runId;
  }

  /** Run after edits to `boot/grub/grub-efi-*.cfg` or GRUB_EFI_MODULES — otherwise iPXE chainloads a stale binary. */
  buildNetbootGrub(): string {
    const run = this.runner.create({
      section: 'build',
      opId: 'build-netboot-grub',
      label: 'netboot grub (bootx64.efi + bootaa64.efi + core.img)',
    });
    this.runner.emit(run, '[build] python -m local.grub_build\n\n');
    void this.runner.spawn(run, 'python', ['-m', 'local.grub_build']).then((code) => this.runner.finalize(run, code));
    return run.runId;
  }

  /** Run after `boot/ipxe/` edits. `--force`: the Build tab must always rebuild; `--chain-base-url`
   *  (bare-metal mode) keeps a manual rebuild from baking in the loopback default. */
  buildIpxe(): string {
    const run = this.runner.create({ section: 'build', opId: 'build-ipxe', label: 'iPXE (amd64 + arm64 EFI + ISO)' });
    const uplink = this.overlay.bmUplink();
    const args = uplink
      ? ['-m', 'local.ipxe_build', '--force', '--chain-base-url', `http://${uplink.ip}:${PORTS.spoke.base}`]
      : ['-m', 'local.ipxe_build', '--force'];
    this.runner.emit(run, `[build] python ${args.join(' ')}\n\n`);
    void this.runner.spawn(run, 'python', args).then((code) => this.runner.finalize(run, code));
    return run.runId;
  }
}
