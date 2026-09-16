import type { DiscoveryRun, DiscoveryRunIssue } from '@repo/api-client';

export type RunStatus = DiscoveryRun['status'];
export type IssueSeverity = DiscoveryRunIssue['severity'];

const SEVERITY_RANK: Record<IssueSeverity, number> = { INFO: 0, WARN: 1, ERROR: 2 };

// the api returns a run's issues oldest-first, so issues[0] is the earliest, not the worst
export function worstSeverity(issues: ReadonlyArray<Pick<DiscoveryRunIssue, 'severity'>>): IssueSeverity | null {
  let worst: IssueSeverity | null = null;
  for (const issue of issues) {
    if (worst === null || SEVERITY_RANK[issue.severity] > SEVERITY_RANK[worst]) worst = issue.severity;
  }
  return worst;
}
