import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { z } from 'zod';

import { JobIdService } from '../../common/job-id.service';
import { extractJobIdFromRequest, type JobIdRequest } from '../../common/middleware/job-id.middleware';
import { logDebug, logError, logInfo } from '../../logger/logger.service';
import { prometheusMetricsRequestSchema, type PrometheusMetricsRequest } from '../monitoring.schema';

import { PROMETHEUS_SERVICE_FACTORY, type PrometheusServiceFactory } from './prometheus.factory';
import { PrometheusMonitoringError } from './prometheus.service';

const APP_CLASS_NAME = 'routes-monitoring-prometheus';

interface ReplyLike {
  status(code: number): ReplyLike;
  setHeader(name: string, value: string): ReplyLike;
  send(body: Buffer): ReplyLike;
}

function jsonBody(payload: unknown): Buffer {
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

@Controller()
export class PrometheusController {
  constructor(
    private readonly jobIdService: JobIdService,
    @Inject(PROMETHEUS_SERVICE_FACTORY)
    private readonly prometheusFactory: PrometheusServiceFactory,
  ) {}

  @Post('api/monitoring/prometheus/metrics')
  @HttpCode(200)
  async prometheusMetrics(@Body() body: unknown, @Req() req: JobIdRequest, @Res() reply: ReplyLike): Promise<void> {
    const jobId = extractJobIdFromRequest(req);
    await this.jobIdService.run(jobId, async () => {
      await this.handle(body, jobId, reply);
    });
  }

  private async handle(body: unknown, jobId: string, reply: ReplyLike): Promise<void> {
    let parsed: PrometheusMetricsRequest;
    try {
      parsed = prometheusMetricsRequestSchema.parse(body ?? {});
    } catch (error) {
      if (error instanceof z.ZodError) {
        await logError(`Validation error: ${error.message}`, { jobId, appClassName: APP_CLASS_NAME });
        reply
          .status(400)
          .setHeader('Content-Type', 'application/json')
          .send(jsonBody({ error: error.message }));
        return;
      }
      throw error;
    }

    await logDebug(`Prometheus metrics - target: ${parsed.target_ip}:${parsed.port}${parsed.metrics_path}`, {
      jobId,
      appClassName: APP_CLASS_NAME,
    });

    const prometheus = this.prometheusFactory.create(jobId);

    try {
      if (parsed.remote_write_url) {
        const result = await prometheus.scrapeAndPush({
          targetIp: parsed.target_ip,
          port: parsed.port,
          metricsPath: parsed.metrics_path,
          protocol: parsed.protocol,
          timeout: parsed.timeout,
          remoteWriteUrl: parsed.remote_write_url,
          remoteWriteUsername: parsed.remote_write_username,
          remoteWritePassword: parsed.remote_write_password,
          hostName: parsed.host_name,
          metricInclude: parsed.metric_include ?? undefined,
          metricExclude: parsed.metric_exclude ?? undefined,
          filterMetric: parsed.filter_metric ?? undefined,
          filterValue: parsed.filter_value,
          filterLabels: parsed.filter_labels ?? undefined,
        });

        await logInfo(
          `Prometheus remote write completed - target: ${parsed.target_ip}:${parsed.port} result: ${String(result.result)}`,
          { jobId, appClassName: APP_CLASS_NAME },
        );

        reply.status(200).setHeader('Content-Type', 'application/json').send(jsonBody(result));
        return;
      }

      const text = await prometheus.scrapeMetrics({
        targetIp: parsed.target_ip,
        port: parsed.port,
        metricsPath: parsed.metrics_path,
        protocol: parsed.protocol,
        timeout: parsed.timeout,
      });

      await logInfo(`Prometheus metrics completed - target: ${parsed.target_ip}:${parsed.port}`, {
        jobId,
        appClassName: APP_CLASS_NAME,
      });

      reply.status(200).setHeader('Content-Type', 'text/plain').send(Buffer.from(text, 'utf8'));
    } catch (error) {
      if (error instanceof PrometheusMonitoringError) {
        await logError(`Prometheus service error: ${error.message}`, { jobId, appClassName: APP_CLASS_NAME });
        reply
          .status(400)
          .setHeader('Content-Type', 'application/json')
          .send(jsonBody({ error: error.message }));
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await logError(`Error processing Prometheus request: ${message}`, { jobId, appClassName: APP_CLASS_NAME });
      reply
        .status(500)
        .setHeader('Content-Type', 'application/json')
        .send(jsonBody({ error: 'Internal server error' }));
    }
  }
}
