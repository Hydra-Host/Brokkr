import type { RunState } from './runner.service';

export const RUN_SINK = Symbol('RUN_SINK');

/** Durability port for run history. Deliberately not an rxjs Subject: SafeSubscriber swallows a
 *  throwing subscriber into reportUnhandledError, which would turn a lost write into silence. */
export interface RunSink {
  onCreate(run: RunState): void;
  /** Fires while the child is alive. The pid must reach disk here: a crash mid-run never calls onFinalize,
   *  and a persisted pid is the only thing a later boot can reconcile an orphan against. */
  onSpawn(run: RunState): void;
  onOutput(run: RunState, chunk: string): void;
  onFinalize(run: RunState): void;
}

export const NULL_RUN_SINK: RunSink = {
  onCreate: () => undefined,
  onSpawn: () => undefined,
  onOutput: () => undefined,
  onFinalize: () => undefined,
};
