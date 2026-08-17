import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';

import { getErrorMessage } from '../common/errors';
import type { QueueCleanableState, QueueJobState } from '../contract';
import { RunnerService } from '../runner/runner.service';
import { addressesOneJob } from './queue-jobs.service';
import { QueueReaderService } from './queue-reader.service';
import { QueueRegistryService } from './queue-registry.service';

export type QueueMutationOutcome = { ok: true; runId: string } | { ok: false; status: 404 | 409; error: string };

// drain/clean have no per-job conflict path, so their contracts declare no 409
type QueueBulkMutationOutcome = { ok: true; runId: string } | { ok: false; status: 404; error: string };

function unknownQueue(prefix: string, name: string): QueueBulkMutationOutcome {
  return { ok: false, status: 404, error: `unknown queue: ${prefix}:${name}` };
}

function unknownJob(prefix: string, name: string, jobId: string): QueueMutationOutcome {
  return { ok: false, status: 404, error: `unknown job: ${prefix}:${name}:${jobId}` };
}

// bullmq reports these refusals only as error text, so the 409 mapping matches on the message. The
// locked message also fires for an already-removed job — the right conflict answer for a duplicate.
function removeRefusal(message: string, jobId: string): string | null {
  if (message.includes('could not be removed because it is locked')) {
    return `job ${jobId} is active (locked by a worker)`;
  }
  if (message.includes('belongs to a job scheduler')) {
    return `job ${jobId} belongs to a job scheduler — remove the schedule at its source, not the occurrence`;
  }
  return null;
}

// the state-race refusal passes bullmq's message through; the missing-key one means the job was
// removed between the listing read and this call, so the mapped text says that instead
function retryRefusal(message: string, jobId: string, state: 'failed' | 'completed'): string | null {
  if (message.includes(`is not in the ${state} state`)) return message;
  if (message.includes('Missing key for job')) {
    return `job ${jobId} no longer exists — it was removed after the listing read`;
  }
  return null;
}

@Injectable()
export class QueueMutationsService {
  constructor(
    private readonly registry: QueueRegistryService,
    private readonly reader: QueueReaderService,
    private readonly runner: RunnerService,
  ) {}

  async retryJob(
    prefix: string,
    name: string,
    jobId: string,
    opts: { state: 'failed' | 'completed'; resetAttempts: boolean },
  ): Promise<QueueMutationOutcome> {
    return this.withJob(prefix, name, jobId, async (job) => {
      const actual = await job.getState();
      if (actual !== opts.state) {
        return { ok: false, status: 409, error: `job ${jobId} is ${actual}, not ${opts.state}` };
      }

      const run = this.runner.create({
        section: 'queues',
        opId: 'retry-job',
        label: `retry ${prefix}/${name}:${jobId}`,
      });
      this.runner.emit(
        run,
        `\r\n[retry] ${prefix}/${name}:${jobId} from ${opts.state}${opts.resetAttempts ? ', attempts reset' : ''}\r\n\r\n`,
      );
      try {
        await job.retry(opts.state, { resetAttemptsMade: opts.resetAttempts });
      } catch (error) {
        const message = getErrorMessage(error);
        const refusal = retryRefusal(message, jobId, opts.state);
        this.runner.emit(run, `[retry] refused: ${refusal ?? message}\r\n`);
        this.runner.finalize(run, 1);
        if (refusal) return { ok: false, status: 409, error: refusal };
        throw error;
      }
      this.runner.emit(run, '[retry] requeued to wait\r\n');
      this.runner.finalize(run, 0);
      return { ok: true, runId: run.runId };
    });
  }

  async removeJob(prefix: string, name: string, jobId: string): Promise<QueueMutationOutcome> {
    return this.withJob(prefix, name, jobId, async (job) => {
      if ((await job.getState()) === 'active') {
        return { ok: false, status: 409, error: `job ${jobId} is active (locked by a worker)` };
      }

      // bullmq only walks :dependencies when removeChildren is set; with it off it deletes the parent
      // and its dependency set, so the refusal that keeps the children reachable has to be ours
      const { unprocessed = 0 } = await job.getDependenciesCount({ unprocessed: true });
      if (unprocessed > 0) {
        return {
          ok: false,
          status: 409,
          error: `job ${jobId} has ${unprocessed} pending child(ren); children are kept — remove them first`,
        };
      }

      const run = this.runner.create({
        section: 'queues',
        opId: 'remove-job',
        label: `remove ${prefix}/${name}:${jobId}`,
      });
      this.runner.emit(run, `\r\n[remove] ${prefix}/${name}:${jobId} — children are kept\r\n\r\n`);
      try {
        // removeChildren defaults to true in bullmq 5.67 and would recursively delete the children
        await job.remove({ removeChildren: false });
      } catch (error) {
        const message = getErrorMessage(error);
        const refusal = removeRefusal(message, jobId);
        this.runner.emit(run, refusal ? `[remove] refused: ${refusal}\r\n` : `[remove] failed: ${message}\r\n`);
        this.runner.finalize(run, 1);
        if (refusal) return { ok: false, status: 409, error: refusal };
        throw error;
      }
      this.runner.emit(run, '[remove] removed\r\n');
      this.runner.finalize(run, 0);
      return { ok: true, runId: run.runId };
    });
  }

  async drainQueue(prefix: string, name: string, opts: { delayed: boolean }): Promise<QueueBulkMutationOutcome> {
    const ref = await this.registry.resolve(prefix, name);
    if (!ref) return unknownQueue(prefix, name);
    const outcome = await this.reader.withQueue(ref, async (queue) => {
      const before = await this.reader.counts(ref);
      const run = this.runner.create({
        section: 'queues',
        opId: 'drain-queue',
        label: `drain ${prefix}/${name}${opts.delayed ? ' +delayed' : ''}`,
      });
      const states: readonly QueueJobState[] = opts.delayed
        ? ['wait', 'paused', 'delayed', 'prioritized']
        : ['wait', 'paused', 'prioritized'];
      this.runner.emit(run, `\r\n[drain] ${prefix}/${name} — removing ${states.join(', ')}\r\n\r\n`);
      try {
        await queue.drain(opts.delayed);
      } catch (error) {
        this.runner.emit(run, `[drain] failed: ${getErrorMessage(error)}\r\n`);
        this.runner.finalize(run, 1);
        throw error;
      }
      // the drain already landed, so a failed count read degrades the report, never the run — leaving
      // it running would leak the row and its log file past retention, which never evicts a live run
      try {
        const after = await this.reader.counts(ref);
        for (const state of states) {
          this.runner.emit(run, `[drain] ${state}: ${before[state]} -> ${after[state]}\r\n`);
        }
      } catch (error) {
        this.runner.emit(run, `[drain] post-drain counts unavailable: ${getErrorMessage(error)}\r\n`);
      }
      this.runner.emit(run, '[drain] active, completed, failed, waiting-children untouched\r\n');
      this.runner.finalize(run, 0);
      return { ok: true as const, runId: run.runId };
    });
    return outcome ?? unknownQueue(prefix, name);
  }

  async cleanQueue(
    prefix: string,
    name: string,
    opts: { state: QueueCleanableState; grace: number; limit: number },
  ): Promise<QueueBulkMutationOutcome> {
    const ref = await this.registry.resolve(prefix, name);
    if (!ref) return unknownQueue(prefix, name);
    const outcome = await this.reader.withQueue(ref, async (queue) => {
      const run = this.runner.create({
        section: 'queues',
        opId: 'clean-queue',
        label: `clean ${prefix}/${name} ${opts.state}`,
      });
      this.runner.emit(
        run,
        `\r\n[clean] ${prefix}/${name} — state ${opts.state}, grace ${opts.grace}ms, limit ${opts.limit}\r\n\r\n`,
      );
      try {
        const ids = await queue.clean(opts.grace, opts.limit, opts.state);
        this.runner.emit(
          run,
          `[clean] removed ${ids.length} ${opts.state} job(s) (grace ${opts.grace}ms, limit ${opts.limit})\r\n`,
        );
        this.runner.finalize(run, 0);
        return { ok: true as const, runId: run.runId };
      } catch (error) {
        this.runner.emit(run, `[clean] failed: ${getErrorMessage(error)}\r\n`);
        this.runner.finalize(run, 1);
        throw error;
      }
    });
    return outcome ?? unknownQueue(prefix, name);
  }

  // precheck-then-mint: the 404 gates and state prechecks return before runner.create, so those
  // refusals leave no run-ledger entry; a refusal the queue raises mid-write finalizes a failed run.
  private async withJob(
    prefix: string,
    name: string,
    jobId: string,
    fn: (job: Job) => Promise<QueueMutationOutcome>,
  ): Promise<QueueMutationOutcome> {
    const ref = await this.registry.resolve(prefix, name);
    if (!ref) return unknownQueue(prefix, name);
    if (!addressesOneJob(jobId)) return unknownJob(prefix, name, jobId);
    const outcome = await this.reader.withQueue(ref, async (queue) => {
      const job = await queue.getJob(jobId);
      return job ? fn(job) : unknownJob(prefix, name, jobId);
    });
    return outcome ?? unknownQueue(prefix, name);
  }
}
