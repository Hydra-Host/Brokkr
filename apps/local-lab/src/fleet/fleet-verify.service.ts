import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { FleetVerifyReportSchema, type FleetVerifyReport } from '@repo/local-lab-contract';
import { getErrorMessage } from '../common/errors';
import type { RunState } from '../runner/runner.service';
import { RunnerService } from '../runner/runner.service';
import { FleetOpRegistry } from './fleet-op-registry';

const execFileP = promisify(execFile);

@Injectable()
export class FleetVerifyService {
  private readonly log = new Logger(FleetVerifyService.name);
  private cache: { at: number; val: FleetVerifyReport } | null = null;
  // bumped on every heal so a slow in-flight verify can't overwrite a freshly-cleared cache.
  private gen = 0;

  constructor(
    private readonly runner: RunnerService,
    private readonly opRegistry: FleetOpRegistry,
  ) {}

  /** 5s TTL so the Fleet 30s poll can't double-spawn python on rapid refetches. `verify` exits 2 when
   *  findings remain (not an error), so stdout is read off the rejection too; a genuine failure throws. */
  async verify(): Promise<FleetVerifyReport> {
    if (this.cache && Date.now() - this.cache.at < 5_000) return this.cache.val;
    const gen = this.gen;
    const parse = (stdout: string): FleetVerifyReport => FleetVerifyReportSchema.parse(JSON.parse(stdout));
    const store = (val: FleetVerifyReport): FleetVerifyReport | Promise<FleetVerifyReport> => {
      // a heal landed mid-flight, so this report predates the repair; re-run for the post-heal snapshot.
      if (this.gen !== gen) return this.verify();
      this.cache = { at: Date.now(), val };
      return val;
    };
    try {
      const { stdout } = await execFileP('python', ['-m', 'local.fleet', 'verify', '--json'], {
        cwd: this.runner.repoRoot,
        timeout: 30_000,
      });
      return store(parse(stdout));
    } catch (e) {
      // only exit 2 promises a report on stdout; anything else is a genuine failure whose cause must survive
      const exit2Stdout =
        e !== null &&
        typeof e === 'object' &&
        'code' in e &&
        e.code === 2 &&
        'stdout' in e &&
        typeof e.stdout === 'string'
          ? e.stdout
          : undefined;
      if (exit2Stdout !== undefined) return store(parse(exit2Stdout));
      this.log.warn(`fleet verify failed: ${getErrorMessage(e)}`);
      throw e;
    }
  }

  heal(): string {
    // acquire before runner.create so a 409 never leaves an orphan run behind.
    const lease = this.opRegistry.acquire({ kind: 'fleet' }, 'fleet-heal');
    let run: RunState;
    try {
      run = this.runner.create({ section: 'fleet', opId: 'fleet-heal', label: 'fleet-heal' });
      lease.bind(run.runId);
    } catch (e) {
      lease.release();
      throw e;
    }
    this.log.log('fleet heal: verify --heal');
    void this.runner
      .spawnPty(run, 'python', ['-m', 'local.fleet', 'verify', '--heal'])
      .then((code) => this.runner.finalize(run, code))
      .catch((e) => {
        this.runner.emit(run, `\r\n[heal] error: ${getErrorMessage(e)}\r\n`);
        this.runner.finalize(run, 1);
      })
      // heal repairs the very state verify reports, so drop the memo regardless of outcome.
      .finally(() => {
        this.invalidate();
        lease.release();
      });
    return run.runId;
  }

  private invalidate(): void {
    this.cache = null;
    this.gen++;
  }
}
