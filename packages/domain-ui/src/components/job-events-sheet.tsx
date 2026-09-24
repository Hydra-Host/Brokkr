import type { LifecycleJobSummary } from '@repo/api-client';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@repo/ui/components/sheet';
import { Link } from '@tanstack/react-router';
import { useDiagnosticsApi } from '../hooks/use-diagnostics-api';
import { JobDetail, jobRefFromSummary } from './job-detail';
import { RECORDED_SAGAS_NOTE } from './job-steps-pane';

function ServerJobsLink({ deviceId, jobId }: { deviceId: string; jobId: string }) {
  const { hrefs } = useDiagnosticsApi();
  // the context hands back a built href; Link takes the path and the query apart
  const target = new URL(hrefs.jobs(deviceId, jobId), window.location.origin);
  return (
    <Link to={target.pathname} search={Object.fromEntries(target.searchParams)} className="text-sm underline">
      Open in server jobs
    </Link>
  );
}

export function JobEventsSheet({ job, onClose }: { job: LifecycleJobSummary | null; onClose: () => void }) {
  return (
    <Sheet
      open={job !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-4xl">
        {job !== null && (
          <div className="space-y-4">
            <SheetHeader>
              <SheetTitle>Job details</SheetTitle>
              <SheetDescription>{RECORDED_SAGAS_NOTE}</SheetDescription>
            </SheetHeader>
            <JobDetail
              key={job.id}
              jobId={job.id}
              deviceId={job.deviceId}
              job={jobRefFromSummary(job)}
              footer={job.deviceId === null ? undefined : <ServerJobsLink deviceId={job.deviceId} jobId={job.id} />}
            />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
