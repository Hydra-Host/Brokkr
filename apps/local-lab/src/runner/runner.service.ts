import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as pty from 'node-pty';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Subject } from 'rxjs';

import { getErrorMessage } from '@repo/utils';
import { engineRoot } from '../common/engine-root';
import { type RunSection, type RunStatus } from '../contract';
import { RUN_SINK, type RunSink } from './run-sink';

const MAX_RUN_LOG_BYTES = 2 * 1024 * 1024;

// terminal runs retained per section; each holds up to MAX_RUN_LOG_BYTES of backlog, so this is the
// bound on the runner's resident memory until the durable ledger backs history.
const IN_MEMORY_KEEP = 20;

export interface RunState {
  runId: string;
  section: RunSection;
  opId: string;
  label: string;
  status: RunStatus;
  startedAt: number;
  exitCode: number | null;
  log$: Subject<string>;
  lines: string[];
  bytes: number;
  truncated?: boolean;
  pty?: pty.IPty;
  childPid?: number;
  nodeIndex?: number | null;
  cancelled?: boolean;
}

export type RunInfo = Omit<RunState, 'log$' | 'lines' | 'bytes'>;

@Injectable()
export class RunnerService {
  private readonly log = new Logger(RunnerService.name);
  private readonly runs = new Map<string, RunState>();

  readonly repoRoot = engineRoot();

  // the sink lives here rather than at the ~16 producers because create() is the one point every run
  // provably passes through, so a seventeenth producer cannot forget to record itself.
  constructor(@Inject(RUN_SINK) private readonly sink: RunSink) {}

  // a ledger outage must never take a run down with it, so every hook is best-effort
  private toSink(hook: string, notify: () => void): void {
    try {
      notify();
    } catch (error) {
      this.log.warn(`run sink ${hook} failed: ${getErrorMessage(error)}`);
    }
  }

  create(opts: { section: RunSection; opId: string; label: string; nodeIndex?: number | null }): RunState {
    const run: RunState = {
      runId: randomUUID(),
      section: opts.section,
      opId: opts.opId,
      label: opts.label,
      status: 'running',
      startedAt: Date.now(),
      exitCode: null,
      log$: new Subject<string>(),
      lines: [],
      bytes: 0,
      nodeIndex: opts.nodeIndex ?? null,
    };
    this.runs.set(run.runId, run);
    this.toSink('onCreate', () => this.sink.onCreate(run));
    return run;
  }

  emit(run: RunState, text: string): void {
    run.lines.push(text);
    run.bytes += text.length;
    // length > 1 so an oversized single chunk is never dropped the moment it arrives
    while (run.bytes > MAX_RUN_LOG_BYTES && run.lines.length > 1) {
      run.bytes -= (run.lines.shift() ?? '').length;
      run.truncated = true;
    }
    run.log$.next(text);
    this.toSink('onOutput', () => this.sink.onOutput(run, text));
  }

  finalize(run: RunState, code: number | null): void {
    if (run.status !== 'running') return;
    run.exitCode = code;
    run.status = run.cancelled ? 'cancelled' : code === 0 ? 'passed' : 'failed';
    run.log$.next(`\n[exit ${code}]\n`);
    run.log$.complete();
    this.toSink('onFinalize', () => this.sink.onFinalize(run));
    // re-insert so the map's iteration order tracks finish order, which is what prune evicts by
    this.runs.delete(run.runId);
    this.runs.set(run.runId, run);
    this.prune(run.section, IN_MEMORY_KEEP);
  }

  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'running') return false;
    this.emit(run, `\r\n[cancel requested by API — SIGTERM]\r\n`);
    // set before signalling: a cancel landing between create() and spawn has no child to kill, and
    // this flag is the only thing that stops the spawn from starting one.
    run.cancelled = true;
    if (run.pty) {
      try {
        run.pty.kill('SIGTERM');
        return true;
      } catch (e) {
        this.log.warn(`pty.kill failed for run ${runId}: ${getErrorMessage(e)}`);
      }
    }
    if (run.childPid) {
      try {
        process.kill(-run.childPid, 'SIGTERM');
        return true;
      } catch (e) {
        this.log.warn(`process.kill failed for run ${runId} pid=${run.childPid}: ${getErrorMessage(e)}`);
      }
    }
    return false;
  }

  private abortBeforeStart(run: RunState): Promise<number | null> {
    this.emit(run, `[cancelled before the child started]\r\n`);
    return Promise.resolve(null);
  }

  /** `detached` so an API restart never tree-kills root-owned (sudo) grandchildren (EPERM); COLUMNS widens Rich/CLI tables, FORCE_COLOR keeps ANSI colors without a TTY. */
  spawn(
    run: RunState,
    cmd: string,
    args: string[],
    extraEnv: Record<string, string> = {},
    opts: { cwd?: string } = {},
  ): Promise<number | null> {
    if (run.cancelled) return this.abortBeforeStart(run);
    return new Promise((resolve) => {
      const env = { ...process.env, COLUMNS: '220', FORCE_COLOR: '1', ...extraEnv };
      const child = spawn(cmd, args, {
        cwd: opts.cwd ?? this.repoRoot,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (child.pid) {
        run.childPid = child.pid;
        this.toSink('onSpawn', () => this.sink.onSpawn(run));
      }
      const onData = (b: Buffer) => this.emit(run, b.toString().replace(/\r?\n/g, '\r\n'));
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (e) => {
        run.log$.next(`[spawn error] ${e.message}\n`);
        resolve(1);
      });
      child.on('close', (code) => {
        run.childPid = undefined;
        resolve(code);
      });
    });
  }

  spawnPty(run: RunState, cmd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<number | null> {
    if (run.cancelled) return this.abortBeforeStart(run);
    return new Promise((resolve) => {
      const env = { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1', ...extraEnv };
      let child: pty.IPty;
      try {
        child = pty.spawn(cmd, args, {
          name: 'xterm-256color',
          cols: 140,
          rows: 1000,
          cwd: this.repoRoot,
          env: env as Record<string, string>,
        });
      } catch (error) {
        this.emit(run, `[spawn error] ${getErrorMessage(error)}\r\n`);
        resolve(1);
        return;
      }
      run.pty = child;
      run.childPid = child.pid;
      this.toSink('onSpawn', () => this.sink.onSpawn(run));
      child.onData((d) => this.emit(run, d));
      child.onExit(({ exitCode }) => {
        run.pty = undefined;
        run.childPid = undefined;
        resolve(exitCode);
      });
    });
  }

  remove(runId: string): void {
    this.runs.delete(runId);
  }

  // evicts in finish order (see finalize), not start order: a long run that outlives 20 quick ones
  // must not evict itself the moment it finalizes.
  prune(section: RunSection, keep: number): void {
    const terminal = [...this.runs.values()].filter((r) => r.section === section && r.status !== 'running');
    for (const run of terminal.slice(0, Math.max(0, terminal.length - keep))) this.runs.delete(run.runId);
  }

  getRun(runId: string): RunState | undefined {
    return this.runs.get(runId);
  }

  writeInput(runId: string, data: string): void {
    this.runs.get(runId)?.pty?.write(data);
  }

  resize(runId: string, cols: number, rows: number): void {
    try {
      this.runs.get(runId)?.pty?.resize(cols, rows);
    } catch (error) {
      this.log.debug(`pty.resize failed for run ${runId}: ${getErrorMessage(error)}`);
    }
  }

  // in-memory only, never the ledger: fleet-op-registry decides fleet busyness by scanning this, so a
  // persisted row for a crashed run would wedge every fleet operation forever. RunsService merges the two.
  list(section?: RunSection): RunInfo[] {
    return [...this.runs.values()]
      .filter((r) => !section || r.section === section)
      .map(({ log$, lines, bytes, ...r }) => r)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  stream(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new NotFoundException(`unknown run '${runId}'`);
    return { backlog: runBacklog(run), live$: run.log$ };
  }
}

/** Single source for backlog joins so every consumer (SSE, persisted artifacts, WS replay) carries the truncation marker. */
export function runBacklog(run: Pick<RunState, 'lines' | 'truncated'>): string {
  return (run.truncated ? '[... earlier output truncated ...]\r\n' : '') + run.lines.join('');
}
