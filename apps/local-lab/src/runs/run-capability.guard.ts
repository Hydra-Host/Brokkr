import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { type Capability, capabilityRefusal, requestAllows } from '../common/lab-capability';
import type { Run, RunSection } from '../contract';
import { RunsService } from './runs.service';

// a run is no more privileged than the operation that minted it; every current opId matches its
// section, so an op that ever outranks its own section needs a finer map keyed on opId
const BY_SECTION: Readonly<Record<RunSection, Capability>> = {
  stack: 'admin',
  fleet: 'operate',
  build: 'operate',
  storage: 'operate',
  test: 'operate',
  queues: 'operate',
};

export function runCapability(run: Pick<Run, 'section' | 'opId'>): Capability {
  return BY_SECTION[run.section];
}

/** Reads the requirement off the run's own ledger row: runs are minted at every capability, so a
 *  static annotation on a route keyed by run id would price them all at the cheapest one. */
@Injectable()
export class RunCapabilityGuard implements CanActivate {
  constructor(private readonly runs: RunsService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const required = runCapability(this.runs.get(String(req.params.runId)));
    if (requestAllows(required, req)) return true;
    throw capabilityRefusal(required);
  }
}
