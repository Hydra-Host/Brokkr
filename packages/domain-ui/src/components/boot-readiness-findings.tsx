import type { BootReadinessFinding, DeviceBootReadiness } from '@repo/api-client';
import { isForbiddenError } from '../hooks/api-errors';
import { useDiagnosticsApi } from '../hooks/use-diagnostics-api';
import { BootFindingList } from './boot-finding-list';

// hub-prefix findings are the bridge's DHCP preconditions, which a boot that never asked the bridge did not need
export function partitionReadinessFindings(
  findings: BootReadinessFinding[],
  bootedWithoutDhcp: boolean,
): { blocking: BootReadinessFinding[]; notBlocking: BootReadinessFinding[] } {
  if (!bootedWithoutDhcp) return { blocking: findings, notBlocking: [] };
  return {
    blocking: findings.filter((finding) => finding.source !== 'hub-prefix'),
    notBlocking: findings.filter((finding) => finding.source === 'hub-prefix'),
  };
}

export function BootReadinessFindings({
  readiness,
  error,
  bootExpected,
  emptyText,
  forbiddenText,
}: {
  readiness: DeviceBootReadiness | null;
  error: unknown;
  bootExpected: boolean | null;
  emptyText: string;
  forbiddenText: string;
}) {
  const { gates } = useDiagnosticsApi();
  if (error !== null && error !== undefined) {
    return (
      <p className="text-muted-foreground text-sm">
        {isForbiddenError(error) ? forbiddenText : 'Readiness could not be evaluated.'}
      </p>
    );
  }
  if (readiness === null) return null;
  const canOpenPrefix = gates.can('prefix.open');
  const { blocking, notBlocking } = partitionReadinessFindings(
    readiness.findings,
    readiness.evaluated.bootedWithoutDhcp,
  );
  return (
    <>
      {bootExpected === false && blocking.length > 0 && (
        <p className="text-muted-foreground text-sm">
          No network boot is expected now. These findings would block the next network boot.
        </p>
      )}
      {(blocking.length > 0 || notBlocking.length === 0) && (
        <BootFindingList
          findings={blocking}
          bootExpected={bootExpected}
          canOpenPrefix={canOpenPrefix}
          emptyText={emptyText}
        />
      )}
      {notBlocking.length > 0 && (
        <>
          <p className="text-muted-foreground text-sm">
            This machine reached iPXE without the bridge&apos;s DHCP; these did not block its last boot.
          </p>
          {/* these did not block the last boot, so they take the dormant style whatever bootExpected says */}
          <BootFindingList
            findings={notBlocking}
            bootExpected={false}
            canOpenPrefix={canOpenPrefix}
            emptyText={emptyText}
          />
        </>
      )}
    </>
  );
}
