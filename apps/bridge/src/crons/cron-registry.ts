import type { CronSpec } from './cron-base.js';

const registry: Map<string, CronSpec> = new Map();

function sameShape(a: CronSpec, b: CronSpec): boolean {
  return (
    a.name === b.name &&
    a.intervalMs === b.intervalMs &&
    a.jitterMs === b.jitterMs &&
    a.timeoutMs === b.timeoutMs &&
    a.initialDelayMs === b.initialDelayMs &&
    (a.enabledWhen === undefined) === (b.enabledWhen === undefined)
  );
}

export function register(spec: CronSpec): void {
  const existing = registry.get(spec.name);
  if (existing !== undefined) {
    if (sameShape(existing, spec)) return;
    throw new Error(`cron '${spec.name}' already registered with a different spec`);
  }
  registry.set(spec.name, spec);
}

export function allSpecs(): CronSpec[] {
  return Array.from(registry.values());
}

export function resetForTests(): void {
  registry.clear();
}
