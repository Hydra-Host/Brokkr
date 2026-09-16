import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import type { BridgeHttpStatus } from '../contract';
import { HOSTS } from '../ports';
import { HttpProbeService } from '../status/http-probe.service';

// the pxe socket and readiness counter are newer than the standby block; a bridge without them still parses
const StatusSchema = z.object({
  dhcp_standby_health: z.object({ answering: z.boolean(), pxe_port_bound: z.boolean().optional() }).nullish(),
  readiness_error_count: z.number().int().optional(),
});

@Injectable()
export class BridgeStatusReader {
  private readonly log = new Logger(BridgeStatusReader.name);

  constructor(@Inject(HttpProbeService) private readonly http: Pick<HttpProbeService, 'readJson'>) {}

  async read(port: number): Promise<BridgeHttpStatus | null> {
    const answer = await this.http.readJson(`http://${HOSTS.loopback}:${port}/api/status`);
    if (!answer.ok) {
      this.log.debug(`bridge status read failed on :${port}: ${answer.detail}`);
      return null;
    }
    const parsed = StatusSchema.safeParse(answer.body);
    if (!parsed.success) {
      this.log.debug(`bridge status body unrecognized on :${port}: ${parsed.error.message}`);
      return null;
    }
    const standby = parsed.data.dhcp_standby_health ?? null;
    return {
      answering: standby?.answering ?? null,
      pxePortBound: standby?.pxe_port_bound ?? null,
      readinessErrorCount: parsed.data.readiness_error_count ?? null,
    };
  }
}
