import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Observable } from 'rxjs';
import { z } from 'zod';

import type { InitStatus, InitTask } from '@repo/local-lab-contract';
import { initAggregateState, initFocusTask } from '@repo/local-lab-contract';
import { getErrorMessage } from '../common/errors';
import { ProcessComposeClient } from '../services/process-compose.client';

// devenv task names, colons included; anything else in the log dir is not a task artifact.
const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9_:-]*$/;

const ExitCodeSchema = z.coerce.number().int();

/** Declared in the DAG's own order (the `after` chains in devenv.nix + devenv/modules/{hub,spoke,fleet}.nix):
 *  this is the roster order, so artifact mtimes — which churn as a task writes — never order anything. */
const INIT_TASKS = [
  { name: 'apps:init', label: 'Control center build' },
  { name: 'hub:init', label: 'Hub build' },
  { name: 'hub:migrate', label: 'Hub DB migrate' },
  { name: 'sql-seed:notify', label: 'Seed notify' },
  { name: 'spoke:init', label: 'Spoke build' },
  { name: 'sim:seed', label: 'Sim seed' },
  { name: 'redis-acl:seed', label: 'Redis ACLs' },
  { name: 'zone-crypto:mint-tokens', label: 'Zone tokens' },
  { name: 'zone-crypto:seed-bmc', label: 'BMC secrets' },
  { name: 'fleet:init', label: 'Fleet artifacts' },
];

const DECLARED_TASKS = new Map(INIT_TASKS.map((t, rank) => [t.name, { label: t.label, rank }]));
const declaredRank = (name: string): number => DECLARED_TASKS.get(name)?.rank ?? INIT_TASKS.length;

export interface InitTaskFacts {
  name: string;
  logMtimeMs: number;
  statusMtimeMs: number | null;
  statusCode: number | null;
  malformedStatus: boolean;
  tail?: string;
}

/** Epoch-first, and that order is load-bearing: a task skipped by its status/execIfModified predicate
 *  never enters the log helper, so last bring-up's `.status = 0` would read as completed. */
export function deriveInitTask(facts: InitTaskFacts, socketMtimeMs: number | null): InitTask {
  const label = DECLARED_TASKS.get(facts.name)?.label ?? facts.name;
  const updatedAt = Math.max(facts.logMtimeMs, facts.statusMtimeMs ?? 0) || null;
  const base = { name: facts.name, label, updatedAt };
  const fresh = (mtime: number | null): boolean => socketMtimeMs !== null && mtime !== null && mtime >= socketMtimeMs;

  if (!fresh(facts.logMtimeMs) && !fresh(facts.statusMtimeMs))
    return { ...base, state: 'pending', exitCode: null, detail: null };

  if (fresh(facts.statusMtimeMs)) {
    if (facts.malformedStatus)
      return { ...base, state: 'failed', exitCode: null, detail: 'unreadable exit-status sidecar' };
    if (facts.statusCode === 0) return { ...base, state: 'completed', exitCode: 0, detail: null };
    return {
      ...base,
      state: 'failed',
      exitCode: facts.statusCode,
      detail: facts.tail ?? `exited ${facts.statusCode}`,
    };
  }
  return { ...base, state: 'running', exitCode: null, detail: null };
}

@Injectable()
export class InitTasksService {
  private readonly log = new Logger(InitTasksService.name);

  constructor(private readonly pc: ProcessComposeClient) {}

  list(): InitTask[] {
    const socketMtimeMs = this.pc.socketMtimeMs();
    return this.facts()
      .sort((a, b) => declaredRank(a.name) - declaredRank(b.name) || a.name.localeCompare(b.name))
      .map((facts) => deriveInitTask(facts, socketMtimeMs));
  }

  summary(): InitStatus {
    const tasks = this.list();
    return {
      state: initAggregateState(tasks),
      total: tasks.length,
      completed: tasks.filter((t) => t.state === 'completed').length,
      failed: tasks.filter((t) => t.state === 'failed').length,
      current: initFocusTask(tasks)?.label ?? null,
    };
  }

  /** `pc.taskLogFile` joins the name straight onto the log dir, so the caller-supplied name must be
   *  checked against the derived roster first — the same guard streamDatastoreLog applies. */
  streamLog(name: string): Observable<string> {
    if (!this.names().includes(name)) throw new NotFoundException(`unknown init task '${name}'`);
    return this.pc.streamTaskLog(name);
  }

  private names(): string[] {
    return this.facts().map((f) => f.name);
  }

  private facts(): InitTaskFacts[] {
    let dir: string;
    let entries: string[];
    try {
      dir = this.pc.taskLogDir();
      entries = readdirSync(dir);
    } catch (error) {
      this.log.debug(`init tasks unavailable: ${getErrorMessage(error)}`);
      return [];
    }
    const present = new Set(entries);
    const out: InitTaskFacts[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.log')) continue;
      const name = entry.slice(0, -'.log'.length);
      // a pc process log is `<name>.<stream>.log`, so only a bare `<task>.log` is a task artifact
      if (!TASK_NAME.test(name) || name.endsWith('.stdout') || name.endsWith('.stderr')) continue;
      const logMtimeMs = mtimeOrNull(join(dir, entry));
      if (logMtimeMs === null) continue;
      const statusFile = `${name}.status`;
      const statusMtimeMs = present.has(statusFile) ? mtimeOrNull(join(dir, statusFile)) : null;
      const parsed = statusMtimeMs === null ? null : readExitCode(join(dir, statusFile));
      out.push({
        name,
        logMtimeMs,
        statusMtimeMs,
        statusCode: parsed,
        malformedStatus: statusMtimeMs !== null && parsed === null,
        tail: this.pc.tailFileLast(join(dir, entry)),
      });
    }
    return out;
  }
}

function mtimeOrNull(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function readExitCode(path: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  // only line 1 is the contract; the writer stamp on line 2 is diagnostics, and an empty line 1
  // is a half-written sidecar, never a zero exit.
  const first = (raw.split('\n', 1)[0] ?? '').trim();
  if (first === '') return null;
  const result = ExitCodeSchema.safeParse(first);
  return result.success ? result.data : null;
}
