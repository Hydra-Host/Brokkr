import { ExportLogsJobTypeSchema, type ExportLogsJobType } from '@repo/api-client';
import { LogStreamView } from '@repo/domain-ui/components/log-stream-view';
import { NO_SOL_LOG_MESSAGE, SOL_LOG_ARIA_LABEL } from '@repo/domain-ui/components/sol-log-viewer';
import { isNotFoundError } from '@repo/domain-ui/hooks/api-errors';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@repo/ui/components/card';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@repo/ui/components/select';
import { Skeleton } from '@repo/ui/components/skeleton';
import { Terminal } from 'lucide-react';
import { useState } from 'react';
import { useDeploymentSolLog } from '~/hooks/use-deployment-sol-log';

const JOB_TYPES = ExportLogsJobTypeSchema.options;

export function DeploymentSerialLogCard({ deploymentId }: { deploymentId: string }) {
  const [jobType, setJobType] = useState<ExportLogsJobType>('Provision');

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Terminal className="h-5 w-5" />
            Serial console log
          </CardTitle>
          <CardDescription>
            Console output the bridge captured during the job. The bridge keeps a log for 24 hours after capture.
          </CardDescription>
        </div>
        <Select value={jobType} onValueChange={(value) => setJobType(ExportLogsJobTypeSchema.parse(value))}>
          <SelectTrigger className="w-40">{jobType}</SelectTrigger>
          <SelectContent>
            {JOB_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent>
        <DeploymentSerialLog key={jobType} deploymentId={deploymentId} jobType={jobType} />
      </CardContent>
    </Card>
  );
}

// the tail holds its rows per instance, so the job type key remounts it on a switch
function DeploymentSerialLog({ deploymentId, jobType }: { deploymentId: string; jobType: ExportLogsJobType }) {
  const tail = useDeploymentSolLog(deploymentId, jobType);

  if (tail.isPending) return <Skeleton className="h-32 w-full" />;
  if (tail.isError) {
    return (
      <p className="text-muted-foreground text-sm">
        {isNotFoundError(tail.error)
          ? `No ${jobType} job has run for this deployment.`
          : 'The serial log could not be loaded.'}
      </p>
    );
  }
  return (
    <LogStreamView
      tail={tail}
      ariaLabel={SOL_LOG_ARIA_LABEL}
      emptyMessage={NO_SOL_LOG_MESSAGE}
      waitingMessage="Waiting for console output."
      showLevelFilter={false}
    />
  );
}
