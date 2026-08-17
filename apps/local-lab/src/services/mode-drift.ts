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

function normalizeProc(
  command: string,
  environment: string[],
  dependsOn: string[],
): { command: string; env: string; deps: string } {
  return {
    command,
    env: [...environment].sort().join('\n'),
    deps: [...dependsOn].sort().join(','),
  };
}

function extendedProcDrift(spec: Record<string, unknown>, info: PcProcessConfig): boolean {
  const fields: [string, keyof PcProcessConfig][] = [
    ['readiness_probe', 'ReadinessProbe'],
    ['liveness_probe', 'LivenessProbe'],
    ['shutdown', 'ShutDownParams'],
    ['availability', 'Availability'],
    ['namespace', 'Namespace'],
    ['description', 'Description'],
    ['working_dir', 'WorkingDir'],
    ['log_location', 'LogLocation'],
    ['replicas', 'Replicas'],
    ['disabled', 'Disabled'],
    ['is_elevated', 'IsElevated'],
    ['entrypoint', 'Entrypoint'],
    ['extensions', 'Extensions'],
  ];
  return fields.some(([yamlKey, liveKey]) => canonicalJson(spec[yamlKey]) !== canonicalJson(info[liveKey]));
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
    const live = normalizeProc(info.Command ?? '', info.Environment ?? [], Object.keys(info.DependsOn ?? {}));
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
