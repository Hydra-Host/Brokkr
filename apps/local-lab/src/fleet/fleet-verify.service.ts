import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { FleetVerifyReportSchema, type FleetVerifyReport } from '@repo/local-lab-contract';
import { getErrorMessage } from '@repo/utils';
import { SingleFlightCache } from '../common/single-flight-cache';
import type { RunState } from '../runner/runner.service';
import { RunnerService } from '../runner/runner.service';
import { FleetOpRegistry } from './fleet-op-registry';

const execFileP = promisify(execFile);

// the lab owns the bare-metal probe budget it hands the verifier; the exec timeout adds margin for the
// vm plane and process start, so a run that spends its whole budget still gets to print its report.
const VERIFY_PROBE_BUDGET_SECONDS = 120;
const VERIFY_EXEC_TIMEOUT_MS = (VERIFY_PROBE_BUDGET_SECONDS + 60) * 1_000;
const VERIFY_ARGV = ['-m', 'local.fleet', 'verify', '--probe-budget-seconds', String(VERIFY_PROBE_BUDGET_SECONDS)];

@Injectable()
export class FleetVerifyService {
  private readonly log = new Logger(FleetVerifyService.name);
  // 5s TTL so the Fleet 30s poll can't double-spawn python on rapid refetches; single-flight so a verify
  // that outlives the TTL is joined instead of raced by a second python dialling the same BMCs.
  private readonly report = new SingleFlightCache<FleetVerifyReport>({
    load: () => this.runVerify(),
    ttlMs: 5_000,
    // a heal landing mid-flight invalidates; the reload hands the waiter the post-heal snapshot.
    maxAttempts: 3,
    staleMessage: 'fleet verify kept being invalidated by heals — retry once the heal settles',
    onError: (e) => this.log.warn(`fleet verify failed: ${getErrorMessage(e)}`),
  });

  constructor(
    private readonly runner: RunnerService,
    private readonly opRegistry: FleetOpRegistry,
  ) {}

  verify(): Promise<FleetVerifyReport> {
    return this.report.get();
  }

  /** `verify` exits 2 when findings remain (not an error), so stdout is read off the rejection too;
   *  a genuine failure throws. */
  private async runVerify(): Promise<FleetVerifyReport> {
    const parse = (stdout: string): FleetVerifyReport => FleetVerifyReportSchema.parse(JSON.parse(stdout));
    try {
      const { stdout } = await execFileP('python', [...VERIFY_ARGV, '--json'], {
        cwd: this.runner.repoRoot,
        timeout: VERIFY_EXEC_TIMEOUT_MS,
      });
      return parse(stdout);
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
      if (exit2Stdout !== undefined) return parse(exit2Stdout);
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
      .spawnPty(run, 'python', [...VERIFY_ARGV, '--heal'])
      .then((code) => this.runner.finalize(run, code))
      .catch((e) => {
        this.runner.emit(run, `\r\n[heal] error: ${getErrorMessage(e)}\r\n`);
        this.runner.finalize(run, 1);
      })
      // heal repairs the very state verify reports, so drop the memo regardless of outcome.
      .finally(() => {
        this.report.invalidate();
        lease.release();
      });
    return run.runId;
  }
}
