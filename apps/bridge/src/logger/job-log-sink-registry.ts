export interface JobLogSinkPort {
  enqueue(jobId: string, fields: Record<string, string>): void;
}

let currentSink: JobLogSinkPort | null = null;

export function setJobLogSink(sink: JobLogSinkPort | null): void {
  currentSink = sink;
}

export function getJobLogSink(): JobLogSinkPort | null {
  return currentSink;
}
