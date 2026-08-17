import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../common/device-credential-resolver.service', async () => {
  const actual = await vi.importActual<typeof import('../../common/device-credential-resolver.service')>(
    '../../common/device-credential-resolver.service',
  );
  return {
    ...actual,
    resolveMetricsTarget: vi.fn(),
  };
});

import { JobIdService } from '../../../common/job-id.service';
import { resolveMetricsTarget } from '../../common/device-credential-resolver.service';
import { MonitoringIpmiController } from '../ipmi.controller';
import { IPMIMonitoringError } from '../ipmi.service';
import type { IpmiMonitoringService, IpmiMonitoringServiceFactory } from '../ipmi.types';

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
  executeIpmiCommand: Mock<(...args: any[]) => any>;
  executeBatchIpmiCommands: Mock<(...args: any[]) => any>;
}

function makeController(stub: Partial<ServiceStub> = {}): {
  controller: MonitoringIpmiController;
  service: ServiceStub;
} {
  const service: ServiceStub = {
    executeIpmiCommand: stub.executeIpmiCommand ?? vi.fn(),
    executeBatchIpmiCommands: stub.executeBatchIpmiCommands ?? vi.fn(),
  };
  const factory: IpmiMonitoringServiceFactory = {
    create: () => service as unknown as IpmiMonitoringService,
  };
  return {
    controller: new MonitoringIpmiController(new JobIdService(), factory),
    service,
  };
}

const resolveMock = vi.mocked(resolveMetricsTarget);

beforeEach(() => {
  resolveMock.mockReset();
  resolveMock.mockImplementation(async (args) => ({
    ip: args.ip ?? null,
    username: args.username ?? null,
    password: args.password ?? null,
    usedResolver: false,
  }));
});

describe('routes/monitoring — ipmi', () => {
  describe('TestIPMIMetricsEndpoint', () => {
    it('resolves device_id to creds and runs the command against the resolved target', async () => {
      resolveMock.mockReset();
      resolveMock.mockResolvedValueOnce({
        ip: '172.16.32.10',
        username: 'USERID',
        password: 'secret',
        usedResolver: true,
      });
      const exec = vi.fn().mockResolvedValue({
        result: 'success',
        response: 'ok',
        command: ['sensor'],
        target_ip: '172.16.32.10',
        cipher_used: 17,
      });
      const { controller } = makeController({ executeIpmiCommand: exec });
      const { reply, recorded } = recordingReply();

      await controller.ipmiMetrics({ device_id: '190', command: 'sensor' }, reply);

      expect(recorded.status).toBe(200);
      const call = exec.mock.calls[0];
      expect(call[0]).toBe('172.16.32.10');
      expect(call[1]).toBe('USERID');
      expect(call[2]).toBe('secret');
    });

    it('returns 200 with the service envelope on a successful command', async () => {
      const exec = vi.fn().mockResolvedValue({
        result: 'success',
        response: 'CPU Temp | 45.000 | degrees C | ok',
        command: ['sensor'],
        target_ip: '192.168.1.100',
        cipher_used: 3,
      });
      const { controller } = makeController({ executeIpmiCommand: exec });
      const { reply, recorded } = recordingReply();

      await controller.ipmiMetrics(
        {
          ip: '192.168.1.100',
          username: 'admin',
          password: 'password',
          command: 'sensor',
          port: 623,
        },
        reply,
      );

      expect(recorded.status).toBe(200);
      const body = recorded.body as Record<string, unknown>;
      expect(body.result).toBe('success');
      expect(body).toHaveProperty('response');
      expect(body).toHaveProperty('cipher_used');
    });

    it('returns 400 when the body is empty / missing required fields', async () => {
      const { controller } = makeController();
      const { reply, recorded } = recordingReply();

      await controller.ipmiMetrics(null, reply);

      expect(recorded.status).toBe(400);
      expect(JSON.stringify(recorded.body)).toContain('Field required');
    });

    it('returns 400 with the either/or contract when ip/username/password are partial and device_id is absent', async () => {
      const cases: Array<Record<string, unknown>> = [
        { username: 'admin', password: 'pass', command: 'sensor' },
        { ip: '192.168.1.100', password: 'pass', command: 'sensor' },
        { ip: '192.168.1.100', username: 'admin', command: 'sensor' },
      ];

      for (const payload of cases) {
        const { controller } = makeController();
        const { reply, recorded } = recordingReply();
        await controller.ipmiMetrics(payload, reply);

        expect(recorded.status).toBe(400);
        expect(JSON.stringify(recorded.body)).toContain("'ip'/'username'/'password'");
      }
    });

    it('returns 400 with Field required when command is omitted', async () => {
      const { controller } = makeController();
      const { reply, recorded } = recordingReply();

      await controller.ipmiMetrics({ ip: '192.168.1.100', username: 'admin', password: 'pass' }, reply);

      expect(recorded.status).toBe(400);
      const msg = JSON.stringify(recorded.body);
      expect(msg).toContain('command');
      expect(msg).toContain('Field required');
    });

    it('returns 400 when the service envelope reports result=failure', async () => {
      const exec = vi.fn().mockResolvedValue({
        result: 'failure',
        response: 'Authentication failed',
        command: ['sensor'],
        target_ip: '192.168.1.100',
      });
      const { controller } = makeController({ executeIpmiCommand: exec });
      const { reply, recorded } = recordingReply();

      await controller.ipmiMetrics(
        {
          ip: '192.168.1.100',
          username: 'invalid',
          password: 'invalid',
          command: 'sensor',
        },
        reply,
      );

      expect(recorded.status).toBe(400);
      const body = recorded.body as Record<string, unknown>;
      expect(body.result).toBe('failure');
      expect(body.response).toBe('Authentication failed');
    });

    it('uses the default IPMI port (623) when port is not supplied', async () => {
      const exec = vi.fn().mockResolvedValue({ result: 'success', response: 'ok', target_ip: '192.168.1.100' });
      const { controller } = makeController({ executeIpmiCommand: exec });
      const { reply, recorded } = recordingReply();

      await controller.ipmiMetrics(
        { ip: '192.168.1.100', username: 'admin', password: 'password', command: 'sensor' },
        reply,
      );

      expect(recorded.status).toBe(200);
      expect(exec).toHaveBeenCalledTimes(1);
      const call = exec.mock.calls[0];
      expect(call[0]).toBe('192.168.1.100');
      expect(call[1]).toBe('admin');
      expect(call[2]).toBe('password');
      expect(call[3]).toBe('sensor');
      expect(call[4]).toBe(623);
    });

    it('returns 500 on a generic service error', async () => {
      const { controller } = makeController({
        executeIpmiCommand: vi.fn().mockRejectedValue(new Error('Service error')),
      });
      const { reply, recorded } = recordingReply();

      await controller.ipmiMetrics(
        { ip: '192.168.1.100', username: 'admin', password: 'password', command: 'sensor' },
        reply,
      );

      expect(recorded.status).toBe(500);
      expect(JSON.stringify(recorded.body)).toContain('Internal server error');
    });
  });

  describe('TestIPMIBatchMetricsEndpoint', () => {
    it('returns 200 with the batch envelope on success', async () => {
      const exec = vi.fn().mockResolvedValue({
        target_ip: '192.168.1.100',
        total_commands: 2,
        successful: 2,
        failed: 0,
        results: [
          { command: 'sensor', result: 'success', response: 'CPU Temp | 45.000' },
          { command: 'sdr', result: 'success', response: 'Record count: 25' },
        ],
        cipher_used: 3,
      });
      const { controller } = makeController({ executeBatchIpmiCommands: exec });
      const { reply, recorded } = recordingReply();

      await controller.ipmiBatchMetrics(
        {
          ip: '192.168.1.100',
          username: 'admin',
          password: 'password',
          commands: ['sensor', 'sdr'],
          port: 623,
        },
        reply,
      );

      expect(recorded.status).toBe(200);
      const body = recorded.body as Record<string, unknown>;
      expect(body.successful).toBe(2);
      expect(body.failed).toBe(0);
      expect((body.results as unknown[]).length).toBe(2);
    });

    it('returns 400 when commands is missing', async () => {
      const { controller } = makeController();
      const { reply, recorded } = recordingReply();

      await controller.ipmiBatchMetrics({ ip: '192.168.1.100', username: 'admin', password: 'password' }, reply);

      expect(recorded.status).toBe(400);
      const msg = JSON.stringify(recorded.body);
      expect(msg).toContain('commands');
      expect(msg).toContain('Required');
    });

    it('returns 400 when the service reports no successful commands', async () => {
      const exec = vi.fn().mockResolvedValue({
        target_ip: '192.168.1.100',
        total_commands: 0,
        successful: 0,
        failed: 0,
        results: [],
      });
      const { controller } = makeController({ executeBatchIpmiCommands: exec });
      const { reply, recorded } = recordingReply();

      await controller.ipmiBatchMetrics(
        { ip: '192.168.1.100', username: 'admin', password: 'password', commands: [] },
        reply,
      );

      expect(recorded.status).toBe(400);
      expect((recorded.body as Record<string, unknown>).successful).toBe(0);
    });

    it('returns 400 when commands is a non-array', async () => {
      const { controller } = makeController();
      const { reply, recorded } = recordingReply();

      await controller.ipmiBatchMetrics(
        {
          ip: '192.168.1.100',
          username: 'admin',
          password: 'password',
          commands: 'not-an-array',
        },
        reply,
      );

      expect(recorded.status).toBe(400);
      const msg = JSON.stringify(recorded.body);
      expect(msg).toContain('commands');
      expect(msg).toMatch(/array|Expected array/i);
    });

    it('returns 400 when every command in the batch failed', async () => {
      const exec = vi.fn().mockResolvedValue({
        target_ip: '192.168.1.100',
        total_commands: 2,
        successful: 0,
        failed: 2,
        results: [
          { command: 'sensor', result: 'failed', error: 'Auth failed' },
          { command: 'sdr', result: 'failed', error: 'Auth failed' },
        ],
      });
      const { controller } = makeController({ executeBatchIpmiCommands: exec });
      const { reply, recorded } = recordingReply();

      await controller.ipmiBatchMetrics(
        {
          ip: '192.168.1.100',
          username: 'invalid',
          password: 'invalid',
          commands: ['sensor', 'sdr'],
        },
        reply,
      );

      expect(recorded.status).toBe(400);
      const body = recorded.body as Record<string, unknown>;
      expect(body.successful).toBe(0);
      expect(body.failed).toBe(2);
    });

    it('returns 200 with partial success counts when at least one command succeeded', async () => {
      const exec = vi.fn().mockResolvedValue({
        target_ip: '192.168.1.100',
        total_commands: 2,
        successful: 1,
        failed: 1,
        results: [
          { command: 'sensor', result: 'success', response: 'CPU Temp | 45.000' },
          { command: 'invalid', result: 'failed', error: 'Invalid command' },
        ],
      });
      const { controller } = makeController({ executeBatchIpmiCommands: exec });
      const { reply, recorded } = recordingReply();

      await controller.ipmiBatchMetrics(
        {
          ip: '192.168.1.100',
          username: 'admin',
          password: 'password',
          commands: ['sensor', 'invalid'],
        },
        reply,
      );

      expect(recorded.status).toBe(200);
      const body = recorded.body as Record<string, unknown>;
      expect(body.successful).toBe(1);
      expect(body.failed).toBe(1);
    });
  });

  describe('TestIPMIMonitoringErrorHandling', () => {
    it('maps IPMIMonitoringError to 400 with the service message', async () => {
      const { controller } = makeController({
        executeIpmiCommand: vi.fn().mockRejectedValue(new IPMIMonitoringError('Invalid IPMI command')),
      });
      const { reply, recorded } = recordingReply();

      await controller.ipmiMetrics(
        {
          ip: '192.168.1.100',
          username: 'admin',
          password: 'password',
          command: 'invalid-command',
        },
        reply,
      );

      expect(recorded.status).toBe(400);
      expect(JSON.stringify(recorded.body)).toContain('Invalid IPMI command');
    });

    it('falls through to 500 on unexpected errors', async () => {
      const { controller } = makeController({
        executeIpmiCommand: vi.fn().mockRejectedValue(new TypeError('Invalid configuration')),
      });
      const { reply, recorded } = recordingReply();

      await controller.ipmiMetrics(
        { ip: '192.168.1.100', username: 'admin', password: 'password', command: 'sensor' },
        reply,
      );

      expect(recorded.status).toBe(500);
      expect(JSON.stringify(recorded.body)).toContain('Internal server error');
    });
  });

  describe('TestIPMIRouteHelpers', () => {
    it('forwards every optional parameter (including port) to the service', async () => {
      const exec = vi.fn().mockResolvedValue({ result: 'success', response: 'ok', target_ip: '192.168.1.100' });
      const { controller } = makeController({ executeIpmiCommand: exec });
      const { reply, recorded } = recordingReply();

      await controller.ipmiMetrics(
        {
          ip: '192.168.1.100',
          username: 'admin',
          password: 'password',
          command: 'sensor',
          port: 6230,
        },
        reply,
      );

      expect(recorded.status).toBe(200);
      expect(exec).toHaveBeenCalledTimes(1);
      const call = exec.mock.calls[0];
      expect(call).toEqual(['192.168.1.100', 'admin', 'password', 'sensor', 6230]);
    });

    it('uses the default port (623) on batch when port is not supplied', async () => {
      const exec = vi.fn().mockResolvedValue({
        target_ip: '192.168.1.100',
        total_commands: 1,
        successful: 1,
        failed: 0,
        results: [],
      });
      const { controller } = makeController({ executeBatchIpmiCommands: exec });
      const { reply, recorded } = recordingReply();

      await controller.ipmiBatchMetrics(
        {
          ip: '192.168.1.100',
          username: 'admin',
          password: 'password',
          commands: ['sensor'],
        },
        reply,
      );

      expect(recorded.status).toBe(200);
      const call = exec.mock.calls[0];
      expect(call).toEqual(['192.168.1.100', 'admin', 'password', ['sensor'], 623]);
    });

    it('forwards complex multi-arg commands verbatim to the batch service', async () => {
      const exec = vi.fn().mockResolvedValue({
        target_ip: '192.168.1.100',
        total_commands: 4,
        successful: 4,
        failed: 0,
        results: [],
      });
      const { controller } = makeController({ executeBatchIpmiCommands: exec });
      const { reply, recorded } = recordingReply();

      const complex = ['sensor list', 'sdr type Temperature', 'sel elist last 10', 'dcmi power reading'];

      await controller.ipmiBatchMetrics(
        {
          ip: '192.168.1.100',
          username: 'admin',
          password: 'password',
          commands: complex,
        },
        reply,
      );

      expect(recorded.status).toBe(200);
      const call = exec.mock.calls[0];
      expect(call).toEqual(['192.168.1.100', 'admin', 'password', complex, 623]);
    });
  });
});
