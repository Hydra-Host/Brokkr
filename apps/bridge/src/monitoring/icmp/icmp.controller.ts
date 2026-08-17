import { Body, Controller, Inject, Post, Req, Res } from '@nestjs/common';

import { logDebug, logError, logInfo } from '../../logger/logger.service';
import { getDeviceCredentialResolver } from '../common/device-credential-resolver.service';
import {
  pingBatchRequestSchema,
  pingBatchResponseSchema,
  pingRequestSchema,
  pingResponseSchema,
} from '../monitoring.schema';

import {
  ICMP_SERVICE_FACTORY,
  IcmpMonitoringError,
  type IcmpPingBatchResult,
  type IcmpPingResult,
  type IcmpService,
  type IcmpServiceFactory,
} from './icmp.types';

interface IcmpRequest {
  headers: Record<string, string | string[] | undefined>;
}

interface IcmpReply {
  status(code: number): IcmpReply;
  send(payload: unknown): unknown;
}

function extractJobIdFromHeaders(req: IcmpRequest, body: unknown): string {
  const header = req.headers['x-brokkr-job-id'];
  const headerVal = Array.isArray(header) ? header[0] : header;
  if (typeof headerVal === 'string' && headerVal !== '') return headerVal;
  if (body !== null && typeof body === 'object') {
    const value: unknown = Reflect.get(body as object, 'job_id');
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

function getJsonBody(body: unknown): Record<string, unknown> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    return { ...(body as Record<string, unknown>) };
  }
  return {};
}

function zodErrorText(error: { issues: Array<{ path: (string | number)[]; message: string }> }): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
}

function dropNullsShallow(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

function serializePingResponse(resp: IcmpPingResult): Record<string, unknown> {
  const out: Record<string, unknown> = { result: resp.result, target_ip: resp.target_ip };
  if (resp.error !== null && resp.error !== undefined) out.error = resp.error;
  if (resp.metrics !== null && resp.metrics !== undefined) {
    out.metrics = dropNullsShallow({ ...resp.metrics });
  }
  return out;
}

function serializeBatchResponse(resp: IcmpPingBatchResult): Record<string, unknown> {
  return {
    total_targets: resp.total_targets,
    successful: resp.successful,
    failed: resp.failed,
    results: resp.results,
  };
}

@Controller()
export class MonitoringIcmpController {
  constructor(@Inject(ICMP_SERVICE_FACTORY) private readonly icmpFactory: IcmpServiceFactory) {}

  @Post('api/monitoring/ping')
  async pingMetricsSecure(@Body() body: unknown, @Req() req: IcmpRequest, @Res() reply: IcmpReply): Promise<void> {
    const jobId = extractJobIdFromHeaders(req, body);

    try {
      const parsed = pingRequestSchema.safeParse(getJsonBody(body));
      if (!parsed.success) {
        await logError(`Validation error: ${zodErrorText(parsed.error)}`, { jobId });
        await reply.status(400).send({ error: zodErrorText(parsed.error) });
        return;
      }
      const data = parsed.data;

      let ip: string = '';
      if (data.ip) {
        ip = data.ip;
      } else if (data.device_id) {
        const resolvedIp = await getDeviceCredentialResolver().resolveIp(data.device_id);
        if (resolvedIp === null) {
          await reply.status(400).send({ error: `could not resolve device_id ${data.device_id}` });
          return;
        }
        ip = resolvedIp;
      }

      await logDebug(
        `Ping parameters - IP: ${ip}, count: ${data.count}, timeout: ${data.timeout}, extended: ${data.extended_metrics}`,
        { jobId },
      );

      const icmpService: IcmpService = this.icmpFactory.create(jobId);
      const result = await icmpService.executePingTest({
        ip,
        count: data.count,
        timeout: data.timeout,
        packetSize: data.packet_size,
        interval: data.interval,
        extendedMetrics: data.extended_metrics,
      });

      const respParsed = pingResponseSchema.safeParse(result);
      if (!respParsed.success) {
        await logError(`Response validation error: ${zodErrorText(respParsed.error)}`, { jobId });
        await reply.status(500).send({ error: 'Internal server error' });
        return;
      }
      const status = respParsed.data.result === 'success' ? 200 : 400;
      await reply.status(status).send(serializePingResponse(result));
    } catch (error) {
      if (error instanceof IcmpMonitoringError) {
        await logError(`ICMP monitoring service error: ${error.message}`, { jobId });
        await reply.status(400).send({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await logError(`Error processing request: ${message}`, { jobId });
      await reply.status(500).send({ error: 'Internal server error' });
    }
  }

  @Post('api/monitoring/ping/batch')
  async pingBatchSecure(@Body() body: unknown, @Req() req: IcmpRequest, @Res() reply: IcmpReply): Promise<void> {
    const jobId = extractJobIdFromHeaders(req, body);

    try {
      const parsed = pingBatchRequestSchema.safeParse(getJsonBody(body));
      if (!parsed.success) {
        await logError(`Validation error: ${zodErrorText(parsed.error)}`, { jobId });
        await reply.status(400).send({ error: zodErrorText(parsed.error) });
        return;
      }
      const data = parsed.data;

      await logInfo(`Batch ping request for ${data.targets.length} targets`, { jobId });

      const icmpService: IcmpService = this.icmpFactory.create(jobId);
      const result = await icmpService.executeBatchPingTest({
        targets: data.targets,
        defaultCount: data.default_count,
        defaultTimeout: data.default_timeout,
        defaultPacketSize: data.default_packet_size,
      });

      const respParsed = pingBatchResponseSchema.safeParse(result);
      if (!respParsed.success) {
        await logError(`Response validation error: ${zodErrorText(respParsed.error)}`, { jobId });
        await reply.status(500).send({ error: 'Internal server error' });
        return;
      }
      await reply.status(200).send(serializeBatchResponse(result));
    } catch (error) {
      if (error instanceof IcmpMonitoringError) {
        await logError(`ICMP monitoring service error: ${error.message}`, { jobId });
        await reply.status(400).send({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await logError(`Error processing request: ${message}`, { jobId });
      await reply.status(500).send({ error: 'Internal server error' });
    }
  }
}
