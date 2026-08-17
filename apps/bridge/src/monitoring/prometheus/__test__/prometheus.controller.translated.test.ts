import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { JobIdService } from '../../../common/job-id.service';
import { PrometheusController } from '../prometheus.controller';
import type { PrometheusServiceFactory } from '../prometheus.factory';
import { PrometheusMonitoringError, type PrometheusMonitoringService } from '../prometheus.service';

interface RecordedResponse {
  status: number | null;
  headers: Record<string, string>;
  body: Buffer | null;
}

function recordingReply(): { reply: any; recorded: RecordedResponse } {
  const recorded: RecordedResponse = { status: null, headers: {}, body: null };
  const reply: any = {
    status(code: number) {
      recorded.status = code;
      return reply;
    },
    setHeader(name: string, value: string) {
      recorded.headers[name] = value;
      return reply;
    },
    send(payload: Buffer) {
      recorded.body = payload;
      return reply;
    },
  };
  return { reply, recorded };
}

function parseBodyAsJson(recorded: RecordedResponse): unknown {
  return JSON.parse(recorded.body!.toString('utf8'));
}

interface ServiceStub {
  scrapeMetrics: Mock<(...args: any[]) => any>;
  scrapeAndPush: Mock<(...args: any[]) => any>;
}

function makeController(stub: Partial<ServiceStub> = {}): {
  controller: PrometheusController;
  service: ServiceStub;
} {
  const service: ServiceStub = {
    scrapeMetrics: stub.scrapeMetrics ?? vi.fn(),
    scrapeAndPush: stub.scrapeAndPush ?? vi.fn(),
  };
  const factory: PrometheusServiceFactory = {
    create: () => service as unknown as PrometheusMonitoringService,
  };
  return {
    controller: new PrometheusController(new JobIdService(), factory),
    service,
  };
}

function makeRequest(): any {
  return { headers: {} };
}

beforeEach(() => {});

describe('routes/monitoring — prometheus', () => {
  describe('TestPrometheusMetricsEndpoint', () => {
    it('returns the exposition text with text/plain when no remote_write_url is set', async () => {
      const exposition = '# HELP foo bar\nfoo 1.0\n';
      const scrapeMetrics = vi.fn().mockResolvedValue(exposition);
      const { controller } = makeController({ scrapeMetrics });
      const { reply, recorded } = recordingReply();

      await controller.prometheusMetrics(
        { target_ip: '10.0.0.5', port: 9100, metrics_path: '/metrics' },
        makeRequest(),
        reply,
      );

      expect(recorded.status).toBe(200);
      expect(recorded.headers['Content-Type']).toMatch(/^text\/plain/);
      expect(recorded.body!.toString('utf8')).toBe(exposition);
      expect(scrapeMetrics).toHaveBeenCalledTimes(1);
      expect(scrapeMetrics).toHaveBeenCalledWith({
        targetIp: '10.0.0.5',
        port: 9100,
        metricsPath: '/metrics',
        protocol: 'http',
        timeout: 15,
      });
    });

    it('returns 200 JSON status from scrapeAndPush when remote_write_url is set', async () => {
      const scrapeAndPush = vi.fn().mockResolvedValue({ result: 'success', pushed: 42 });
      const scrapeMetrics = vi.fn();
      const { controller } = makeController({ scrapeAndPush, scrapeMetrics });
      const { reply, recorded } = recordingReply();

      await controller.prometheusMetrics(
        {
          target_ip: '10.0.0.5',
          remote_write_url: 'https://thanos.example.com/api/v1/receive',
          host_name: 'gpu-1',
        },
        makeRequest(),
        reply,
      );

      expect(recorded.status).toBe(200);
      const body = parseBodyAsJson(recorded);
      expect(body).toEqual({ result: 'success', pushed: 42 });
      expect(scrapeAndPush).toHaveBeenCalledTimes(1);
      expect(scrapeMetrics).not.toHaveBeenCalled();
    });

    it('returns 400 when target_ip is missing', async () => {
      const { controller } = makeController();
      const { reply, recorded } = recordingReply();

      await controller.prometheusMetrics({ port: 9100 }, makeRequest(), reply);

      expect(recorded.status).toBe(400);
      expect(JSON.stringify(parseBodyAsJson(recorded))).toContain('target_ip');
    });

    it('returns 400 when target_ip is not a valid IPv4 string', async () => {
      const { controller } = makeController();
      const { reply, recorded } = recordingReply();

      await controller.prometheusMetrics({ target_ip: 'not-an-ip' }, makeRequest(), reply);

      expect(recorded.status).toBe(400);
      expect(JSON.stringify(parseBodyAsJson(recorded))).toContain('target_ip');
    });

    it('returns 400 when scrapeMetrics throws PrometheusMonitoringError', async () => {
      const scrapeMetrics = vi.fn().mockRejectedValue(new PrometheusMonitoringError('scrape blew up'));
      const { controller } = makeController({ scrapeMetrics });
      const { reply, recorded } = recordingReply();

      await controller.prometheusMetrics({ target_ip: '10.0.0.5' }, makeRequest(), reply);

      expect(recorded.status).toBe(400);
      expect(JSON.stringify(parseBodyAsJson(recorded))).toContain('scrape blew up');
    });

    it('returns 500 with a generic message on unexpected errors (no internal leakage)', async () => {
      const scrapeMetrics = vi.fn().mockRejectedValue(new TypeError('internal detail'));
      const { controller } = makeController({ scrapeMetrics });
      const { reply, recorded } = recordingReply();

      await controller.prometheusMetrics({ target_ip: '10.0.0.5' }, makeRequest(), reply);

      expect(recorded.status).toBe(500);
      const body = parseBodyAsJson(recorded) as Record<string, unknown>;
      expect(body.error).toBe('Internal server error');
      expect(String(body.error)).not.toContain('internal detail');
    });
  });
});
