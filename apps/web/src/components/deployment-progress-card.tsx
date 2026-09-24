import type { LifecycleJobSummary } from '@repo/api-client';
import { JobDetail, jobRefFromSummary } from '@repo/domain-ui/components/job-detail';
import { formatDate, useLifecycleJobs } from '@repo/domain-ui/components/job-history-columns';
import { OPEN_JOB_POLL_MS } from '@repo/domain-ui/hooks/poll-intervals';
import { useDiagnosticsApi } from '@repo/domain-ui/hooks/use-diagnostics-api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Label } from '@repo/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@repo/ui/components/select';
import { Skeleton } from '@repo/ui/components/skeleton';
import { ListChecks } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

const JOBS_PAGE = { query: { page: 1, pageSize: 20 } };

export function DeploymentProgressCard({ deploymentId }: { deploymentId: string }) {
  const { gates } = useDiagnosticsApi();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListChecks className="h-5 w-5" />
          Provisioning progress
        </CardTitle>
        <CardDescription>Steps the bridge ran for this deployment&apos;s lifecycle jobs.</CardDescription>
      </CardHeader>
      <CardContent>
        {gates.isLoading ? <Skeleton className="h-40 w-full" /> : <DeploymentProgress deploymentId={deploymentId} />}
      </CardContent>
    </Card>
  );
}

// mounted once the gates settle: the job binding follows them while the list query key does not
function DeploymentProgress({ deploymentId }: { deploymentId: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [anyInFlight, setAnyInFlight] = useState(false);
  const selectId = useId();
  const jobs = useLifecycleJobs(
    JOBS_PAGE,
    { deploymentId },
    { refetchInterval: anyInFlight ? OPEN_JOB_POLL_MS : false },
  );

  useEffect(() => {
    setAnyInFlight(jobs.rows.some((row) => row.completedAt === null));
  }, [jobs.rows]);

  if (jobs.isPending) return <Skeleton className="h-40 w-full" />;
  if (jobs.isError) {
    return <p className="text-muted-foreground text-sm">The lifecycle jobs could not be loaded.</p>;
  }

  // the list arrives newest first (the server's default sort), so the first row is the current job
  const selected = jobs.rows.find((row) => row.id === selectedId) ?? jobs.rows[0];
  if (selected === undefined) {
    return <p className="text-muted-foreground text-sm">No lifecycle job has run for this deployment yet.</p>;
  }

  return (
    <div className="space-y-4">
      {jobs.rows.length > 1 && (
        <div className="flex items-center gap-2">
          <Label htmlFor={selectId}>Job</Label>
          <Select value={selected.id} onValueChange={setSelectedId}>
            <SelectTrigger id={selectId} className="w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {jobs.rows.map((job) => (
                <SelectItem key={job.id} value={job.id}>
                  {jobLabel(job)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {/* no device id on purpose: with the log pane off nothing reads it, and the renter card must not become a path to device-scoped reads */}
      <JobDetail key={selected.id} jobId={selected.id} deviceId={null} job={jobRefFromSummary(selected)} logs={false} />
    </div>
  );
}

function jobLabel(job: LifecycleJobSummary): string {
  return `${job.jobType} · ${formatDate(job.createdAt)}`;
}
