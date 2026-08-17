import { logError, logInfo } from '../logger/logger.service.js';

let stopGraceMs = 5_000;
let uniformRandom: (min: number, max: number) => number = (min, max) => min + Math.random() * (max - min);

export function setStopGraceMsForTests(ms: number): void {
  stopGraceMs = ms;
}

export function resetStopGraceMsForTests(): void {
  stopGraceMs = 5_000;
}

export function setUniformRandomForTests(fn: (min: number, max: number) => number): void {
  uniformRandom = fn;
}

export function resetUniformRandomForTests(): void {
  uniformRandom = (min, max) => min + Math.random() * (max - min);
}

export interface CronSpec {
  readonly name: string;
  readonly intervalMs: number;
  readonly run: (signal: AbortSignal) => Promise<void>;
  readonly jitterMs?: number;
  readonly timeoutMs?: number;
  readonly enabledWhen?: () => boolean;
  readonly initialDelayMs?: number;
}

export interface CronState {
  name: string;
  intervalSeconds: number;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  nextRunAt: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
  running: boolean;
}

function reprError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.constructor.name}(${JSON.stringify(error.message)})`;
  }
  return String(error);
}

export class PeriodicTask {
  readonly spec: CronSpec;
  readonly state: CronState;
  private shutdownFired = false;
  private shutdownWaiters: Array<() => void> = [];
  private loopPromise: Promise<void> | null = null;
  private stopped = false;
  private activeRunController: AbortController | null = null;

  constructor(spec: CronSpec) {
    this.spec = spec;
    this.state = {
      name: spec.name,
      intervalSeconds: spec.intervalMs / 1000,
      lastRunAt: null,
      lastSuccessAt: null,
      nextRunAt: null,
      lastError: null,
      consecutiveFailures: 0,
      running: false,
    };
  }

  async start(): Promise<void> {
    if (this.loopPromise !== null) {
      throw new Error(`PeriodicTask '${this.spec.name}' already started`);
    }
    this.loopPromise = this.loop();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.setShutdown();
    if (this.loopPromise === null) return;
    const loop = this.loopPromise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), stopGraceMs);
    });
    await Promise.race([
      loop.then(
        () => 'done' as const,
        () => 'done' as const,
      ),
      grace,
    ]);
    if (timer !== undefined) clearTimeout(timer);
  }

  private setShutdown(): void {
    this.shutdownFired = true;
    this.activeRunController?.abort(new Error('cron shutting down'));
    const waiters = this.shutdownWaiters;
    this.shutdownWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private isShutdown(): boolean {
    return this.shutdownFired;
  }

  private async sleepOrShutdown(seconds: number): Promise<boolean> {
    if (seconds <= 0) {
      return this.isShutdown();
    }
    if (this.isShutdown()) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (fired: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fired);
      };
      const timer = setTimeout(() => finish(false), seconds * 1000);
      this.shutdownWaiters.push(() => finish(true));
    });
  }

  computeNextRun(): Date {
    const jitterSeconds = (this.spec.jitterMs ?? 0) / 1000;
    let offset = 0;
    if (jitterSeconds > 0) {
      offset = uniformRandom(-jitterSeconds, jitterSeconds);
    }
    const intervalSeconds = this.spec.intervalMs / 1000;
    const deltaSeconds = Math.max(0, intervalSeconds + offset);
    return new Date(Date.now() + deltaSeconds * 1000);
  }

  private async loop(): Promise<void> {
    const spec = this.spec;
    const jobId = `cron-${spec.name}`;
    const initialDelaySeconds = (spec.initialDelayMs ?? 0) / 1000;

    if (initialDelaySeconds > 0) {
      if (await this.sleepOrShutdown(initialDelaySeconds)) {
        return;
      }
    }

    while (!this.isShutdown()) {
      const nextRun = this.computeNextRun();
      this.state.nextRunAt = nextRun;

      const sleepSeconds = Math.max(0, (nextRun.getTime() - Date.now()) / 1000);
      if (await this.sleepOrShutdown(sleepSeconds)) {
        return;
      }

      if (spec.enabledWhen !== undefined) {
        let gateValue: boolean;
        try {
          gateValue = spec.enabledWhen();
        } catch (error) {
          await logError(`cron '${spec.name}' enabledWhen raised ${reprError(error)}, skipping iteration`, { jobId });
          continue;
        }
        if (!gateValue) {
          continue;
        }
      }

      this.state.running = true;
      this.state.lastRunAt = new Date();
      try {
        await this.runOnce();
        this.state.lastSuccessAt = this.state.lastRunAt;
        this.state.lastError = null;
        this.state.consecutiveFailures = 0;
      } catch (error) {
        this.state.lastError = reprError(error);
        this.state.consecutiveFailures += 1;
        await logError(
          `cron '${spec.name}' iteration failed (failures=${this.state.consecutiveFailures}): ${reprError(error)}`,
          { jobId },
        );
      } finally {
        this.state.running = false;
      }
    }

    await logInfo(`cron '${spec.name}' loop exited cleanly`, { jobId });
  }

  private async runOnce(): Promise<void> {
    const controller = new AbortController();
    this.activeRunController = controller;
    // shutdown may have fired between scheduling and arming the controller.
    if (this.isShutdown()) controller.abort(new Error('cron shutting down'));
    try {
      await this.runOnceWith(controller);
    } finally {
      this.activeRunController = null;
    }
  }

  private async runOnceWith(controller: AbortController): Promise<void> {
    const spec = this.spec;
    if (spec.timeoutMs === undefined) {
      await spec.run(controller.signal);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutMessage = `cron '${spec.name}' iteration exceeded ${spec.timeoutMs}ms`;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        const abortError = new Error(timeoutMessage);
        controller.abort(abortError);
        reject(abortError);
      }, spec.timeoutMs);
    });
    const runPromise = spec.run(controller.signal);
    runPromise.then(
      () => {
        if (timedOut) {
          void logInfo(`cron '${spec.name}' orphan iteration (post-timeout) completed successfully`, {
            jobId: `cron-${spec.name}`,
          });
        }
      },
      (error: unknown) => {
        if (timedOut) {
          void logError(`cron '${spec.name}' orphan iteration (post-timeout) failed: ${reprError(error)}`, {
            jobId: `cron-${spec.name}`,
          });
        }
      },
    );
    try {
      await Promise.race([runPromise, timeoutPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
