import { Logger } from '@nestjs/common';
import { load as loadYaml } from 'js-yaml';
import { readFileSync } from 'node:fs';

import { isPlainObject } from '../common/type-guards';
import { type PcProcessConfig, type ProcessComposeClient } from './process-compose.client';

const log = new Logger('mode-drift');

function canonicalJson(v: unknown): string {
  const isEmptyish = (x: unknown): boolean =>
    x === undefined ||
    x === null ||
    x === false ||
    x === '' ||
    (Array.isArray(x) && x.length === 0) ||
    (isPlainObject(x) && Object.keys(x).length === 0);
  if (isEmptyish(v)) return '';
  const canon = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(canon);
    if (isPlainObject(x)) {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(x).sort()) out[k] = canon(x[k]);
      return out;
    }
    return x;
  };
  return JSON.stringify(canon(v));
}

// tasks.json is one content-addressed file holding every devenv task, so any task's content moving
// re-hashes it and rewrites the --task-file argument of every process command at once.
const TASK_FILE_STORE_PATH = /\/nix\/store\/[a-z0-9]+-([^\s"']*tasks\.json)/g;

export const normalizeCommand = (command: string): string =>
  command.replace(TASK_FILE_STORE_PATH, '/nix/store/<hash>-$1');

function normalizeProc(
  command: string,
  environment: string[],
  dependsOn: string[],
): { command: string; env: string; deps: string } {
  return {
    command: normalizeCommand(command),
    // A set: a pinned spec repeats the project-level block the overlay still carries, and to
    // process-compose a repeated identical entry says nothing (KEY=a vs KEY=b stay distinct).
    env: [...new Set(environment)].sort().join('\n'),
    deps: [...dependsOn].sort().join(','),
  };
}

// Spec fields beyond command/environment/depends_on, as {rendered yaml key → live pc key}. The
// daemon rewrites readiness_probe, shutdown, availability and replicas, so those never compare.
export const EXTENDED_SPEC_FIELDS: ReadonlyArray<[string, keyof PcProcessConfig]> = [
  ['liveness_probe', 'livenessProbe'],
  ['namespace', 'namespace'],
  ['description', 'description'],
  ['working_dir', 'workingDir'],
  ['log_location', 'logLocation'],
  ['disabled', 'disabled'],
  ['is_elevated', 'isElevated'],
  ['entrypoint', 'entrypoint'],
  ['extensions', 'extensions'],
];

/** True when a rendered spec still describes the process the daemon runs — the task-file hash is
 *  normalized away, exactly as swapDiffSet's own comparison does. */
export function specMatchesRunning(
  spec: { command: string; environment: string[]; dependsOn: string[] },
  info: PcProcessConfig,
): boolean {
  const desired = normalizeProc(spec.command, spec.environment, spec.dependsOn);
  const live = normalizeProc(info.command ?? '', info.environment ?? [], Object.keys(info.dependsOn ?? {}));
  return desired.command === live.command && desired.env === live.env && desired.deps === live.deps;
}

function extendedProcDrift(spec: Record<string, unknown>, info: PcProcessConfig): boolean {
  return EXTENDED_SPEC_FIELDS.some(
    ([yamlKey, liveKey]) => canonicalJson(spec[yamlKey]) !== canonicalJson(info[liveKey]),
  );
}

export async function swapDiffSet(pc: Pick<ProcessComposeClient, 'processInfo'>, cfgPath: string): Promise<string[]> {
  const doc = loadYaml(readFileSync(cfgPath, 'utf8'));
  if (!isPlainObject(doc)) return [];
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string') : [];
  const projectEnv = strList(doc.environment);
  const procs = isPlainObject(doc.processes) ? doc.processes : {};
  const changed: string[] = [];
  const extended: string[] = [];
  for (const [name, spec] of Object.entries(procs)) {
    if (!isPlainObject(spec)) continue;
    const desired = normalizeProc(
      typeof spec.command === 'string' ? spec.command : '',
      [...projectEnv, ...strList(spec.environment)],
      isPlainObject(spec.depends_on) ? Object.keys(spec.depends_on) : [],
    );
    let info: Awaited<ReturnType<ProcessComposeClient['processInfo']>>;
    try {
      info = await pc.processInfo(name);
    } catch {
      continue;
    }
    const live = normalizeProc(info.command ?? '', info.environment ?? [], Object.keys(info.dependsOn ?? {}));
    if (desired.command !== live.command || desired.env !== live.env || desired.deps !== live.deps) {
      changed.push(name);
    }
    if (extendedProcDrift(spec, info)) extended.push(name);
  }
  const extraExtended = extended.filter((n) => !changed.includes(n));
  if (extraExtended.length > 0) {
    log.warn(`[mode] extended-surface drift (warn-only): {${extraExtended.join(', ')}}`);
  }
  return changed;
}
