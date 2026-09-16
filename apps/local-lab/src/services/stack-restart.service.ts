import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { RESTART_STALE_AFTER_MS, type RestartState } from '@repo/local-lab-contract';
import { getErrorMessage } from '@repo/utils';
import type { RunState } from '../runner/runner.service';
import { RunnerService } from '../runner/runner.service';
import { SudoService } from '../sudo/sudo.service';
import { devenvRoot } from './paths';
import {
  clearRestartExit,
  clearRestartMarker,
  readRestartExit,
  readRestartMarker,
  restartExitPath,
  restartLogPath,
  writeRestartMarker,
  type RestartWipe,
} from './restart-marker';

const execFileP = promisify(execFile);

// server-only: the 6h floor has no consumer, unlike the stale bound the client must also apply
const ABANDON_AFTER_MS = 6 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15_000;

/** One discriminant, pure and testable: a non-zero child exit is `failed`, never something a
 *  consumer's `if (!pending) return` can swallow. A clean exit is `idle` — there is nothing to show. */
export function restartStatus(exit: number | null, ageMs: number): RestartState['status'] {
  if (exit !== null) return exit === 0 ? 'idle' : 'failed';
  return ageMs > RESTART_STALE_AFTER_MS ? 'stale' : 'pending';
}

export interface RestartOpts {
  reason: string;
  wipe?: RestartWipe;
  /** Called when the child never got off the ground, so a caller's own retry latch can re-arm. */
  onLaunchFailure?: () => void;
}

/** The wipe half of the chain. `stack-down` is followed by `;`, not `&&`: its body is three `|| true`
 *  statements, so its exit code proves nothing — `stack-await-down` is the real gate. */
function wipeStage(wipe: RestartWipe): string {
  // reslot carries its own down+teardown — don't double-down
  if (wipe === 'stack-reslot') return 'stack-reslot';
  return wipe === 'stack-wipe-data' ? 'stack-down; stack-await-down && stack-wipe-data' : wipe;
}

/** The chain as an operator reads it in the run log and the op's task line. */
export function restartChain(wipe: RestartWipe | undefined): string {
  return wipe === undefined ? 'stack-down; stack-up' : `${wipeStage(wipe)}; stack-up`;
}

/** `stack-down` kills THIS lab process, so the child must outlive it (detached, unref'd); the `;`
 *  before `stack-up` is load-bearing — a refused wipe must never leave the operator without a cockpit. */
export function restartScript(wipe: RestartWipe | undefined, exitPath: string | null): string {
  const body = wipe === undefined ? 'stack-down; stack-up; up=$?' : `${wipeStage(wipe)}; wipe=$?; stack-up; up=$?`;
  // the bring-up runs either way, so its code alone would report a refused wipe as a clean recreation
  const code = wipe === undefined ? '$up' : '$(( wipe != 0 ? wipe : up ))';
  const sidecar = exitPath ? `; printf '%s\\n' "${code}" >>"$LAB_RESTART_EXIT"` : '';
  return `sleep 2; ${body}${sidecar}`;
}

@Injectable()
export class StackRestartService implements OnApplicationBootstrap {
  private readonly log = new Logger(StackRestartService.name);
  private readonly devenvRoot = devenvRoot();

  private restartInFlight = false;
  private sweeper?: NodeJS.Timeout;
  private failureLogged = false;

  constructor(
    private readonly sudo: SudoService,
    private readonly runner: RunnerService,
  ) {}

  onApplicationBootstrap(): void {
    this.sweepMarker();
    this.sweeper = setInterval(() => this.sweepMarker(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  async restartStackDetached(run: RunState, opts: RestartOpts): Promise<void> {
    if (this.restartInFlight) {
      this.refuse(run, 'a full stack restart is already in flight — ignoring the duplicate request');
      return;
    }
    this.restartInFlight = true;

    const pf = await this.sudo.preflight();
    if (!pf.ok) {
      this.restartInFlight = false;
      this.refuse(run, `pre-flight failed: ${pf.reason}`);
      return;
    }

    if (opts.wipe === 'stack-reset' || opts.wipe === 'stack-purge') {
      const siblings = await this.liveSiblingSockets();
      if (siblings.length > 0) {
        this.restartInFlight = false;
        this.refuse(
          run,
          `another checkout's stack is live (${siblings.join(', ')}) — ${opts.wipe} deletes host-global caches it is using. Stop it (task down in that checkout) and retry.`,
        );
        return;
      }
    }

    // cancelRun force-finalizes runs it cannot signal — never detach behind a cancelled run.
    if (run.status !== 'running') {
      this.restartInFlight = false;
      return;
    }

    const logFile = restartLogPath();
    const exitPath = restartExitPath();
    const script = restartScript(opts.wipe, exitPath);
    const chain = restartChain(opts.wipe);
    this.log.warn(`${opts.reason} — recreating the stack (${chain}). Progress: ${logFile}`);
    this.runner.emit(
      run,
      `${opts.reason} — recreating the stack (${chain}). Progress: ${logFile}. ` +
        `the control-center API is going down now; the UI reconnects when the stack is back.\n`,
    );
    try {
      writeRestartMarker({
        opId: run.opId,
        runId: run.runId,
        reason: opts.reason,
        wipe: opts.wipe,
        startedAt: Date.now(),
        logPath: logFile,
      });
      mkdirSync(dirname(logFile), { recursive: true });
      const out = openSync(logFile, 'a');
      const child = spawn('bash', ['-c', script], {
        cwd: this.devenvRoot,
        env: exitPath ? { ...process.env, LAB_RESTART_EXIT: exitPath } : process.env,
        detached: true,
        stdio: ['ignore', out, out],
      });
      const launchFailed = (detail: string) => {
        this.restartInFlight = false;
        clearRestartMarker();
        opts.onLaunchFailure?.();
        this.log.error(`full stack restart ${detail}`);
        this.runner.emit(run, `full stack restart ${detail}\n`);
        this.runner.finalize(run, 1);
      };
      // 'spawn' and 'error' are mutually exclusive (Node >=15.1); success is finalized by the caller
      // at this detach point, so this handler must never finalize a launched child.
      child.on('error', (err) => launchFailed(`failed to launch: ${err.message}`));
      child.on('exit', (code, signal) => {
        if (code !== 0) launchFailed(`exited abnormally (code=${code}, signal=${signal})`);
      });
      child.unref();
      closeSync(out);
    } catch (e) {
      this.restartInFlight = false;
      clearRestartMarker();
      opts.onLaunchFailure?.();
      const msg = getErrorMessage(e);
      this.log.error(`failed to launch the full stack restart: ${msg}`);
      this.runner.emit(run, `${msg}\n`);
      this.runner.finalize(run, 1);
    }
  }

  restartState(): RestartState {
    const marker = readRestartMarker();
    if (!marker) return { status: 'idle' };
    const status = restartStatus(readRestartExit(), Date.now() - marker.startedAt);
    if (status === 'idle') return { status };
    return {
      status,
      reason: marker.reason,
      opId: marker.opId,
      runId: marker.runId,
      startedAt: marker.startedAt,
      logPath: marker.logPath,
    };
  }

  private refuse(run: RunState, reason: string): void {
    this.log.warn(reason);
    this.runner.emit(run, `${reason}\n`);
    this.runner.finalize(run, 1);
  }

  /** Retires the marker only on positive evidence the child is gone; a healthy read is NOT evidence —
   *  the child sleeps 2s before teardown, so a tick in that window would release the latch mid-wipe. */
  private sweepMarker(): void {
    const marker = readRestartMarker();
    if (!marker) return;
    const exit = readRestartExit();
    if (exit === null) {
      // the child died before writing a sidecar (SIGKILL, host reboot); the floor is generous because
      // a cold purge legitimately rebuilds for a long time with nothing to report
      if (Date.now() - marker.startedAt > ABANDON_AFTER_MS)
        this.retire(`abandoning a stack restart that never reported an exit — see ${marker.logPath}`);
      return;
    }
    // it wrote its own exit code, so it ran to completion and nothing is in flight
    this.restartInFlight = false;
    if (exit === 0) {
      this.retire('detached stack restart completed');
      return;
    }
    // the marker stays so restartState keeps reporting the failure until the next restart supersedes it
    if (!this.failureLogged) {
      this.failureLogged = true;
      this.log.warn(`the detached stack restart exited ${exit} — see ${marker.logPath}`);
    }
  }

  private retire(message: string): void {
    clearRestartMarker();
    clearRestartExit();
    this.restartInFlight = false;
    this.failureLogged = false;
    this.log.log(message);
  }

  /** Same socket-glob shape as stack-down-others: sibling runtimes are $DEVENV_RUNTIME's siblings, and
   *  our own socket is skipped by path AND by inode (it can be reached under either name). */
  private async liveSiblingSockets(): Promise<string[]> {
    const runtime = process.env.DEVENV_RUNTIME;
    if (!runtime) return [];
    const self = process.env.PC_SOCKET_PATH || join(runtime, 'pc.sock');
    const parent = dirname(runtime);
    let entries: string[];
    try {
      entries = readdirSync(parent).filter((e) => e.startsWith('devenv-'));
    } catch (error) {
      this.log.debug(`sibling scan failed: ${getErrorMessage(error)}`);
      return [];
    }
    const live: string[] = [];
    for (const entry of entries) {
      const sock = join(parent, entry, 'pc.sock');
      if (sock === self || !existsSync(sock) || sameFile(sock, self)) continue;
      if (await this.socketAnswers(sock)) live.push(sock);
    }
    return live;
  }

  private async socketAnswers(sock: string): Promise<boolean> {
    const bin = process.env.PROCESS_COMPOSE_BIN || 'process-compose';
    try {
      await execFileP(bin, ['-U', '-u', sock, 'process', 'list', '-o', 'json'], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }
}

function sameFile(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.ino === sb.ino && sa.dev === sb.dev;
  } catch {
    return false;
  }
}
