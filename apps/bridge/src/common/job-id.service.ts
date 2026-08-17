import { Injectable } from '@nestjs/common';

import { getJobId, runWithJobId, setJobIdInCurrentContext } from '../logger/context/job-id.context';

import { type ClientIpHeaders, extractClientIp, extractClientIpFromRequest } from './middleware/client-ip';

export { extractClientIp, extractClientIpFromRequest, type ClientIpHeaders };

@Injectable()
export class JobIdService {
  run<T>(jobId: string, fn: () => T): T {
    return runWithJobId(jobId, fn);
  }

  current(): string {
    return getJobId();
  }

  set(jobId: string): void {
    setJobIdInCurrentContext(jobId);
  }

  extractClientIp(headers: ClientIpHeaders, remoteAddr: string | null | undefined): string {
    return extractClientIp(headers, remoteAddr);
  }
}
