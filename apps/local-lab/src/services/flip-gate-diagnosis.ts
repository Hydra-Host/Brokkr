import { classifyProc, type PcProcess } from './proc-health';

const SKIPPED_REMEDY = 'only a dependency transition clears Skipped — run Redeploy';

export function diagnoseGateTimeout(
  names: string[],
  procs: PcProcess[],
  tail: (name: string) => string | undefined,
): string {
  const byName = new Map(procs.map((p) => [p.name, p]));
  return names
    .map((name) => {
      const p = byName.get(name);
      if (!p) return `${name}: absent from process-compose`;
      const diag = classifyProc(p, true);
      const head = `${name}: ${p.status} / ${p.is_ready ?? '?'} (restarts ${p.restarts ?? 0}, exit ${p.exit_code ?? '-'}, ${diag.status})`;
      const remedy = p.status.toLowerCase() === 'skipped' ? ` — ${SKIPPED_REMEDY}` : '';
      const last = tail(name);
      return last ? `${head}${remedy}\n  ${last}` : `${head}${remedy}`;
    })
    .join('\n');
}
