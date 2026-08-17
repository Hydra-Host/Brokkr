import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../common/device-credential-resolver.service', async () => {
  const actual = await vi.importActual<typeof import('../../common/device-credential-resolver.service')>(
    '../../common/device-credential-resolver.service',
  );
  return {
    ...actual,
    getDeviceCredentialResolver: vi.fn(),
  };
});

import { getDeviceCredentialResolver } from '../../common/device-credential-resolver.service';
import { MonitoringIcmpController } from '../icmp.controller';
import {
  IcmpMonitoringError,
  type IcmpPingBatchResult,
  type IcmpPingResult,
  type IcmpService,
  type IcmpServiceFactory,
} from '../icmp.types';

interface RecordedResponse {
  status: number | null;
  body: unknown;
}

function recordingReply(): { reply: any; recorded: RecordedResponse } {
  const recorded: RecordedResponse = { status: null, body: null };
  const reply: any = {
    status(code: number) {
      recorded.status = code;
      return reply;
    },
    async send(payload: unknown) {
      recorded.body = payload;
      return reply;
    },
  };
  return { reply, recorded };
}

interface ServiceStub {
  executePingTest: Mock<(...args: any[]) => any>;
  executeBatchPingTest: Mock<(...args: any[]) => any>;
}

function makeController(stub: Partial<ServiceStub> = {}): {
  controller: MonitoringIcmpController;
  service: ServiceStub;
} {
  const service: ServiceStub = {
    executePingTest: stub.executePingTest ?? vi.fn(),
    executeBatchPingTest: stub.executeBatchPingTest ?? vi.fn(),
  };
  const factory: IcmpServiceFactory = {
    create: () => service as unknown as IcmpService,
  };
  return { controller: new MonitoringIcmpController(factory), service };
}

const resolverMock = vi.mocked(getDeviceCredentialResolver);

beforeEach(() => {
  resolverMock.mockReset();
});

describe('routes/monitoring — icmp', () => {
  describe('TestICMPPingEndpoint', () => {
    it('returns 200 with the service envelope on a successful ping', async () => {
      const pingResult: IcmpPingResult = {
        result: 'success',
        target_ip: '192.168.1.100',
        metrics: {
          icmpping: 1,
          icmppingloss: 0.0,
          icmppingsec: 0.0105,
          'icmppingsec.min': null,
          'icmppingsec.max': null,
          'icmppingsec.avg': null,
          packets_sent: 5,
          packets_received: 5,
        },
      };
      const { controller, service } = makeController({
        executePingTest: vi.fn().mockResolvedValue(pingResult),
      });
      const { reply, recorded } = recordingReply();

      await controller.pingMetricsSecure(
        {
          ip: '8.8.8.8',
          count: 3,
          timeout: 5,
          packet_size: 64,
          extended_metrics: true,
        },
        { headers: {} },
        reply,
      );

      expect(recorded.status).toBe(200);
      const body = recorded.body as Record<string, unknown>;
      expect(body.result).toBe('success');
      expect(body.metrics).toMatchObject({ icmppingsec: 0.0105 });
      expect(service.executePingTest).toHaveBeenCalledTimes(1);
    });

    it('resolves device_id to a BMC IP and pings that IP', async () => {
      const pingResult: IcmpPingResult = {
        result: 'success',
        target_ip: '172.16.32.10',
        metrics: {
          icmpping: 1,
          icmppingloss: 0.0,
          icmppingsec: null,
          'icmppingsec.min': null,
          'icmppingsec.max': null,
          'icmppingsec.avg': null,
          packets_sent: 5,
          packets_received: 5,
        },
      };
      const resolveIp = vi.fn().mockResolvedValue('172.16.32.10');
      resolverMock.mockReturnValue({ resolveIp } as never);
      const { controller, service } = makeController({
        executePingTest: vi.fn().mockResolvedValue(pingResult),
      });
      const { reply, recorded } = recordingReply();

      await controller.pingMetricsSecure({ device_id: '190' }, { headers: {} }, reply);

      expect(recorded.status).toBe(200);
      expect(resolveIp).toHaveBeenCalledWith('190');
      expect(service.executePingTest.mock.calls[0][0].ip).toBe('172.16.32.10');
    });

    it('returns 400 when the device_id is unresolvable and never pings', async () => {
      const resolveIp = vi.fn().mockResolvedValue(null);
      resolverMock.mockReturnValue({ resolveIp } as never);
      const { controller, service } = makeController();
      const { reply, recorded } = recordingReply();

      await controller.pingMetricsSecure({ device_id: 'ghost' }, { headers: {} }, reply);

      expect(recorded.status).toBe(400);
      expect(JSON.stringify(recorded.body)).toContain('ghost');
      expect(service.executePingTest).not.toHaveBeenCalled();
    });

    it('returns 400 with the either/or contract on an empty body', async () => {
      const { controller } = makeController();
      const { reply, recorded } = recordingReply();

      await controller.pingMetricsSecure(null, { headers: {} }, reply);

      expect(recorded.status).toBe(400);
      expect(JSON.stringify(recorded.body)).toContain("'ip' or 'device_id'");
    });

    it('returns 400 with the either/or contract when neither ip nor device_id is supplied', async () => {
      const { controller } = makeController();
      const { reply, recorded } = recordingReply();

      await controller.pingMetricsSecure({ count: 3 }, { headers: {} }, reply);

      expect(recorded.status).toBe(400);
      expect(JSON.stringify(recorded.body)).toContain("'ip' or 'device_id'");
    });

    it('returns 500 when the service throws a generic error', async () => {
      const { controller } = makeController({
        executePingTest: vi.fn().mockRejectedValue(new Error('Service error')),
      });
      const { reply, recorded } = recordingReply();

      await controller.pingMetricsSecure({ ip: '8.8.8.8' }, { headers: {} }, reply);

      expect(recorded.status).toBe(500);
      expect(JSON.stringify(recorded.body)).toContain('Internal server error');
    });

    it('returns 400 when the service envelope reports result=failure', async () => {
      const failResult: IcmpPingResult = {
        result: 'failure',
        target_ip: '192.168.1.100',
        error: 'Host unreachable',
        metrics: undefined as never,
      };
      const { controller } = makeController({
        executePingTest: vi.fn().mockResolvedValue(failResult),
      });
      const { reply, recorded } = recordingReply();

      await controller.pingMetricsSecure({ ip: '192.168.1.999' }, { headers: {} }, reply);

      expect(recorded.status).toBe(400);
      expect((recorded.body as Record<string, unknown>).result).toBe('failure');
    });
  });

  describe('TestICMPBatchPingEndpoint', () => {
    it('returns 200 with the batch envelope on success', async () => {
      const batch: IcmpPingBatchResult = {
        total_targets: 2,
        successful: 2,
        failed: 0,
        results: [
          { ip: '8.8.8.8', result: 'success' },
          { ip: '1.1.1.1', result: 'success' },
        ],
      };
      const { controller } = makeController({
        executeBatchPingTest: vi.fn().mockResolvedValue(batch),
      });
      const { reply, recorded } = recordingReply();

      await controller.pingBatchSecure(
        {
          targets: [{ ip: '8.8.8.8' }, { ip: '1.1.1.1' }],
          default_count: 3,
          default_timeout: 5,
        },
        { headers: {} },
        reply,
      );

      expect(recorded.status).toBe(200);
      const body = recorded.body as Record<string, unknown>;
      expect(body.successful).toBe(2);
      expect(body.failed).toBe(0);
      expect((body.results as unknown[]).length).toBe(2);
    });

    it('returns 400 when targets is missing', async () => {
      const { controller } = makeController();
      const { reply, recorded } = recordingReply();

      await controller.pingBatchSecure({ default_count: 3 }, { headers: {} }, reply);

      expect(recorded.status).toBe(400);
      const msg = JSON.stringify(recorded.body);
      expect(msg).toContain('targets');
    });

    it('returns 200 with empty results when targets is an empty array', async () => {
      const batch: IcmpPingBatchResult = {
        total_targets: 0,
        successful: 0,
        failed: 0,
        results: [],
      };
      const { controller } = makeController({
        executeBatchPingTest: vi.fn().mockResolvedValue(batch),
      });
      const { reply, recorded } = recordingReply();

      await controller.pingBatchSecure({ targets: [] }, { headers: {} }, reply);

      expect(recorded.status).toBe(200);
      expect((recorded.body as Record<string, unknown>).total_targets).toBe(0);
    });

    it('returns 400 when targets is a non-array', async () => {
      const { controller } = makeController();
      const { reply, recorded } = recordingReply();

      await controller.pingBatchSecure({ targets: 'not-an-array' }, { headers: {} }, reply);

      expect(recorded.status).toBe(400);
      expect(JSON.stringify(recorded.body)).toContain('targets');
    });

    it('uses default count/timeout/packet_size when only targets is supplied', async () => {
      const batch: IcmpPingBatchResult = {
        total_targets: 1,
        successful: 1,
        failed: 0,
        results: [{ ip: '8.8.8.8', result: 'success' }],
      };
      const exec = vi.fn().mockResolvedValue(batch);
      const { controller } = makeController({ executeBatchPingTest: exec });
      const { reply, recorded } = recordingReply();

      await controller.pingBatchSecure({ targets: [{ ip: '8.8.8.8' }] }, { headers: {} }, reply);

      expect(recorded.status).toBe(200);
      expect(exec).toHaveBeenCalledTimes(1);
      const arg = exec.mock.calls[0][0];
      expect(arg.targets).toEqual([{ ip: '8.8.8.8' }]);
      expect(arg.defaultCount).toBe(5);
      expect(arg.defaultTimeout).toBe(3);
      expect(arg.defaultPacketSize).toBe(56);
    });
  });

  describe('TestICMPMonitoringErrorHandling', () => {
    it('maps IcmpMonitoringError to 400 with the service message', async () => {
      const { controller } = makeController({
        executePingTest: vi.fn().mockRejectedValue(new IcmpMonitoringError('Invalid IP address')),
      });
      const { reply, recorded } = recordingReply();

      await controller.pingMetricsSecure({ ip: 'invalid-ip' }, { headers: {} }, reply);

      expect(recorded.status).toBe(400);
      expect(JSON.stringify(recorded.body)).toContain('Invalid IP address');
    });

    it('falls through to 500 on unexpected errors', async () => {
      const { controller } = makeController({
        executePingTest: vi.fn().mockRejectedValue(new TypeError('Invalid configuration')),
      });
      const { reply, recorded } = recordingReply();

      await controller.pingMetricsSecure({ ip: '8.8.8.8' }, { headers: {} }, reply);

      expect(recorded.status).toBe(500);
      expect(JSON.stringify(recorded.body)).toContain('Internal server error');
    });
  });

  describe('TestICMPRouteHelpers', () => {
    it('forwards every optional parameter to the service', async () => {
      const pingResult: IcmpPingResult = {
        result: 'success',
        target_ip: '192.168.1.100',
        metrics: {
          icmpping: 1,
          icmppingloss: 0,
          icmppingsec: 0,
          'icmppingsec.min': null,
          'icmppingsec.max': null,
          'icmppingsec.avg': null,
          packets_sent: 1,
          packets_received: 1,
        },
      };
      const exec = vi.fn().mockResolvedValue(pingResult);
      const { controller } = makeController({ executePingTest: exec });
      const { reply, recorded } = recordingReply();

      await controller.pingMetricsSecure(
        {
          ip: '8.8.8.8',
          count: 10,
          timeout: 2,
          packet_size: 32,
          interval: 500,
          extended_metrics: true,
        },
        { headers: {} },
        reply,
      );

      expect(recorded.status).toBe(200);
      expect(exec).toHaveBeenCalledWith({
        ip: '8.8.8.8',
        count: 10,
        timeout: 2,
        packetSize: 32,
        interval: 500,
        extendedMetrics: true,
      });
    });

    it('uses ping default parameters when only ip is supplied', async () => {
      const pingResult: IcmpPingResult = {
        result: 'success',
        target_ip: '192.168.1.100',
        metrics: {
          icmpping: 1,
          icmppingloss: 0,
          icmppingsec: 0,
          'icmppingsec.min': null,
          'icmppingsec.max': null,
          'icmppingsec.avg': null,
          packets_sent: 1,
          packets_received: 1,
        },
      };
      const exec = vi.fn().mockResolvedValue(pingResult);
      const { controller } = makeController({ executePingTest: exec });
      const { reply } = recordingReply();

      await controller.pingMetricsSecure({ ip: '8.8.8.8' }, { headers: {} }, reply);

      expect(exec).toHaveBeenCalledWith({
        ip: '8.8.8.8',
        count: 5,
        timeout: 3,
        packetSize: 56,
        interval: 1000,
        extendedMetrics: false,
      });
    });
  });
});
