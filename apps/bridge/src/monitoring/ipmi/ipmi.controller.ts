import { Body, Controller, HttpStatus, Inject, Post, Res } from '@nestjs/common';

import { JobIdService } from '../../common/job-id.service';
import { logDebug, logError } from '../../logger/logger.service';
import { resolveMetricsTarget } from '../common/device-credential-resolver.service';
import {
  ipmiBatchMetricsRequestSchema,
  ipmiBatchMetricsResponseSchema,
  ipmiMetricsRequestSchema,
  ipmiMetricsResponseSchema,
} from '../monitoring.schema';
import { IPMIMonitoringError } from './ipmi.service';
import { IPMI_MONITORING_SERVICE_FACTORY, type IpmiMonitoringServiceFactory } from './ipmi.types';

const APP_CLASS_NAME = 'routes-monitoring-ipmi';

interface ReplyLike {
  status(code: number): ReplyLike;
  send(body: unknown): unknown;
}

function errorBody(error: string): { error: string } {
  return { error };
}

function excludeNone(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val !== null && val !== undefined) {
      out[key] = val;
    }
  }
  return out;
}

@Controller('api/monitoring/ipmi')
export class MonitoringIpmiController {
  constructor(
    private readonly jobIdService: JobIdService,
    @Inject(IPMI_MONITORING_SERVICE_FACTORY)
    private readonly ipmiServiceFactory: IpmiMonitoringServiceFactory,
  ) {}

  @Post('metrics')
  async ipmiMetrics(@Body() body: unknown, @Res() reply: ReplyLike): Promise<void> {
    const jobId = this.jobIdService.current();

    try {
      const parsed = ipmiMetricsRequestSchema.safeParse(body ?? {});
      if (!parsed.success) {
        await logError(`Validation error: ${parsed.error.message}`, { jobId, appClassName: APP_CLASS_NAME });
        await reply.status(HttpStatus.BAD_REQUEST).send(errorBody(parsed.error.message));
        return;
      }
      const req = parsed.data;

      const resolved = await resolveMetricsTarget({
        deviceId: req.device_id ?? null,
        ip: req.ip ?? null,
        username: req.username ?? null,
        password: req.password ?? null,
      });
      if (!(resolved.ip && resolved.username && resolved.password)) {
        await reply
          .status(HttpStatus.BAD_REQUEST)
          .send(errorBody(`could not resolve BMC credentials for device_id ${req.device_id}`));
        return;
      }

      await logDebug(
        `IPMI parameters - IP: ${resolved.ip}, username: ${resolved.username}, port: ${req.port}, command: ${req.command}`,
        { jobId, appClassName: APP_CLASS_NAME },
      );

      const ipmiService = this.ipmiServiceFactory.create(jobId);
      const result = await ipmiService.executeIpmiCommand(
        resolved.ip,
        resolved.username,
        resolved.password,
        req.command,
        req.port,
      );

      const respParsed = ipmiMetricsResponseSchema.safeParse(result);
      if (!respParsed.success) {
        await logError(`Validation error: ${respParsed.error.message}`, { jobId, appClassName: APP_CLASS_NAME });
        await reply.status(HttpStatus.BAD_REQUEST).send(errorBody(respParsed.error.message));
        return;
      }
      const resp = respParsed.data;
      const status = resp.result === 'success' ? HttpStatus.OK : HttpStatus.BAD_REQUEST;
      await reply.status(status).send(excludeNone(resp as unknown as Record<string, unknown>));
    } catch (error) {
      if (error instanceof IPMIMonitoringError) {
        await logError(`IPMI monitoring service error: ${error.message}`, { jobId, appClassName: APP_CLASS_NAME });
        await reply.status(HttpStatus.BAD_REQUEST).send(errorBody(error.message));
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await logError(`Error processing request: ${message}`, { jobId, appClassName: APP_CLASS_NAME });
      await reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send(errorBody('Internal server error'));
    }
  }

  @Post('batch-metrics')
  async ipmiBatchMetrics(@Body() body: unknown, @Res() reply: ReplyLike): Promise<void> {
    const jobId = this.jobIdService.current();

    try {
      const parsed = ipmiBatchMetricsRequestSchema.safeParse(body ?? {});
      if (!parsed.success) {
        await logError(`Validation error: ${parsed.error.message}`, { jobId, appClassName: APP_CLASS_NAME });
        await reply.status(HttpStatus.BAD_REQUEST).send(errorBody(parsed.error.message));
        return;
      }
      const req = parsed.data;

      await logDebug(
        `IPMI batch - IP: ${req.ip}, username: ${req.username}, port: ${req.port}, ${req.commands.length} commands`,
        { jobId, appClassName: APP_CLASS_NAME },
      );

      const ipmiService = this.ipmiServiceFactory.create(jobId);
      const result = await ipmiService.executeBatchIpmiCommands(
        req.ip,
        req.username,
        req.password,
        req.commands,
        req.port,
      );

      const respParsed = ipmiBatchMetricsResponseSchema.safeParse(result);
      if (!respParsed.success) {
        await logError(`Validation error: ${respParsed.error.message}`, { jobId, appClassName: APP_CLASS_NAME });
        await reply.status(HttpStatus.BAD_REQUEST).send(errorBody(respParsed.error.message));
        return;
      }
      const resp = respParsed.data;
      const status = resp.successful > 0 ? HttpStatus.OK : HttpStatus.BAD_REQUEST;
      await reply.status(status).send(excludeNone(resp as unknown as Record<string, unknown>));
    } catch (error) {
      if (error instanceof IPMIMonitoringError) {
        await logError(`IPMI monitoring service error: ${error.message}`, { jobId, appClassName: APP_CLASS_NAME });
        await reply.status(HttpStatus.BAD_REQUEST).send(errorBody(error.message));
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await logError(`Error processing request: ${message}`, { jobId, appClassName: APP_CLASS_NAME });
      await reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send(errorBody('Internal server error'));
    }
  }
}
