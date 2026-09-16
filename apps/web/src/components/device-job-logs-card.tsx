import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@repo/ui/components/select';
import { Skeleton } from '@repo/ui/components/skeleton';
import { isRecord } from '@repo/utils';
import { ScrollText } from 'lucide-react';
import { JobLogViewer } from '~/components/job-log-viewer';
import { tsr } from '~/lib/api';

interface DeviceJobLogsCardProps {
  deviceId: string;
  displayName: string;
  requestedJobId?: string;
  onSelectJob: (jobId: string) => void;
}

function jobLabel(job: { jobType: string; createdAt: string; status: string }): string {
  return `${job.jobType} — ${new Date(job.createdAt).toLocaleString()} (${job.status})`;
}

export function DeviceJobLogsCard({ deviceId, displayName, requestedJobId, onSelectJob }: DeviceJobLogsCardProps) {
  const { data, isPending, isError, error } = tsr.listDeviceJobs.useQuery({
    queryKey: ['device-jobs', deviceId],
    queryData: { params: { deviceId } },
  });

  const jobs = data?.status === 200 ? data.body.jobs : [];
  const newestJob = jobs.reduce<(typeof jobs)[number] | undefined>(
    (newest, candidate) =>
      !newest || new Date(candidate.createdAt).getTime() > new Date(newest.createdAt).getTime() ? candidate : newest,
    undefined,
  );
  const selectedJobId = requestedJobId ?? newestJob?.id;
  const selectedJob = jobs.find((candidate) => candidate.id === selectedJobId);
  const forbidden = isError && isRecord(error) && error.status === 403;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ScrollText className="h-5 w-5" />
          Job Logs
        </CardTitle>
        <CardDescription>Bridge and hub logs for jobs on {displayName}.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {forbidden ? (
          <p className="text-muted-foreground text-sm">You do not have access to job logs.</p>
        ) : isError ? (
          <p className="text-muted-foreground text-sm">Failed to load jobs.</p>
        ) : isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : jobs.length === 0 ? (
          <p className="text-muted-foreground text-sm">No jobs recorded for this device.</p>
        ) : (
          <>
            <Select value={selectedJobId} onValueChange={onSelectJob}>
              <SelectTrigger className="max-w-xl">{selectedJob ? jobLabel(selectedJob) : 'Select a job'}</SelectTrigger>
              <SelectContent>
                {jobs.map((candidate) => (
                  <SelectItem key={candidate.id} value={candidate.id}>
                    {jobLabel(candidate)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedJobId !== undefined && <JobLogViewer key={selectedJobId} jobId={selectedJobId} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}
