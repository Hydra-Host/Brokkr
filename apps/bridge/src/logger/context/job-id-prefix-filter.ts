import { getJobId } from './job-id.context';

export interface JobIdPrefixFilterInput {
  jobId?: string | null;
}

export class JobIdPrefixFilter {
  private readonly prefixes: readonly string[];

  constructor(prefixes: readonly string[]) {
    this.prefixes = prefixes;
  }

  accept(input: JobIdPrefixFilterInput): boolean {
    if (this.prefixes.length === 0) return true;
    const jobId = input.jobId || getJobId();
    if (!jobId) return true;
    return !this.prefixes.some((p) => jobId.startsWith(p));
  }
}
