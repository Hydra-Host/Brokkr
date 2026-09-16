import type { BootFinding } from '@repo/utils';

const byCheck = new Map<string, readonly BootFinding[]>();

// null-safe: a check that threw, was skipped, or is stubbed records nothing rather than a bad entry.
export function setBootReadinessFindings(check: string, findings: readonly BootFinding[] | null | undefined): void {
  if (findings === null || findings === undefined) {
    byCheck.delete(check);
    return;
  }
  byCheck.set(check, [...findings]);
}

export function getBootReadinessFindings(): BootFinding[] {
  return [...byCheck.values()].flat();
}

export function resetBootReadinessFindingsForTests(): void {
  byCheck.clear();
}
