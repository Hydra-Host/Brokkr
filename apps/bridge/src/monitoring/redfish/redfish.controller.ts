import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { JobIdService } from '../../common/job-id.service.js';
import { extractJobIdFromRequest } from '../../common/middleware/job-id.middleware.js';
import { createRedfishProxyService, RedfishError } from '../../oob/redfish-proxy.service.js';
import { getDeviceCredentialResolver, resolveMetricsTarget } from '../common/device-credential-resolver.service.js';
import { redfishMetricsRequestSchema } from '../monitoring.schema.js';

const AUTH_REJECTED_STATUSES = new Set<number>([401, 403]);

@Controller()
export class MonitoringRedfishController {
  constructor(private readonly jobIdService: JobIdService) {}

  @Post('api/monitoring/redfish/metrics')
  async redfishMetrics(@Body() body: unknown, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const jobId = extractJobIdFromRequest(req);
    await this.jobIdService.run(jobId, () => this.handle(body, jobId, reply));
  }

  private async handle(body: unknown, jobId: string, reply: FastifyReply): Promise<void> {
    try {
      const parsed = redfishMetricsRequestSchema.safeParse(body ?? {});
      if (!parsed.success) {
        await reply.status(400).send({ error: parsed.error.message });
        return;
      }
      const req = parsed.data;

      const resolved = await resolveMetricsTarget({
        deviceId: req.device_id ?? null,
        ip: req.bmc_ip ?? null,
        username: req.username ?? null,
        password: req.password ?? null,
      });
      let bmcIp = resolved.ip;
      let username = resolved.username;
      let password = resolved.password;
      const usedResolver = resolved.usedResolver;

      if (!(bmcIp && username && password)) {
        await reply.status(400).send({
          error: `could not resolve BMC credentials for device_id ${req.device_id ?? null}`,
        });
        return;
      }

      const buildPayload = (ip: string, user: string, pw: string): Record<string, unknown> => {
        const payload: Record<string, unknown> = {
          bmc_ip: ip,
          endpoint: req.endpoint,
          method: req.method,
          username: user,
          password: pw,
          port: req.port,
          protocol: req.protocol,
        };
        if (req.headers != null) {
          payload['headers'] = req.headers;
        }
        return payload;
      };

      const service = createRedfishProxyService(jobId);

      let result = await service.performRedfishOperation(buildPayload(bmcIp, username, password));

      if (AUTH_REJECTED_STATUSES.has(result.status) && usedResolver && req.device_id) {
        const resolver = getDeviceCredentialResolver();
        resolver.invalidate(req.device_id);
        const creds = await resolver.resolve(req.device_id);
        if (creds !== null) {
          bmcIp = creds.bmcIp;
          username = creds.username;
          password = creds.password;
          result = await service.performRedfishOperation(buildPayload(bmcIp, username, password));
        }
      }

      let data: unknown;
      try {
        data = JSON.parse(result.content.toString('utf8'));
      } catch {
        data = { raw: result.content.toString('utf8') };
      }

      await reply.status(result.status).send(data);
    } catch (e) {
      if (e instanceof RedfishError) {
        await reply.status(400).send({ error: e.message });
        return;
      }
      await reply.status(500).send({ error: 'Internal server error' });
    }
  }
}
