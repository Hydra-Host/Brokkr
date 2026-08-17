import { Injectable } from '@nestjs/common';

import { LeaderElectionService } from './leader-election.service';

@Injectable()
export class LeaderHeartbeatCron {
  constructor(private readonly service: LeaderElectionService | null = null) {}

  async tick(signal?: AbortSignal): Promise<void> {
    if (this.service === null) return;
    await this.service.heartbeat(signal);
  }
}
