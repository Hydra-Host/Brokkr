import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../snmp.service', async () => {
  const actual = await vi.importActual<typeof import('../snmp.service')>('../snmp.service');
  return {
    ...actual,
    createSnmpMonitoringService: vi.fn(),
  };
});

import { JobIdService } from '../../../common/job-id.service';
import { MonitoringSnmpController } from '../snmp.controller';
import { createSnmpMonitoringService, SnmpMonitoringError, type SnmpMonitoringService } from '../snmp.service';

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

function makeRequest(): any {
  return { headers: {} };
}

interface ServiceStub {
  executeSnmpGet: Mock<(...args: any[]) => any>;
  executeSnmpWalk: Mock<(...args: any[]) => any>;
}

const createMock = vi.mocked(createSnmpMonitoringService);

function makeController(stub: Partial<ServiceStub> = {}): {
  controller: MonitoringSnmpController;
  service: ServiceStub;
} {
  const service: ServiceStub = {
    executeSnmpGet: stub.executeSnmpGet ?? vi.fn(),
    executeSnmpWalk: stub.executeSnmpWalk ?? vi.fn(),
  };
  createMock.mockReturnValue(service as unknown as SnmpMonitoringService);
  return {
    controller: new MonitoringSnmpController(new JobIdService()),
    service,
  };
}

beforeEach(() => {
  createMock.mockReset();
});

describe('routes/monitoring — snmp', () => {
  describe('TestSnmpGetEndpoint', () => {
    it('returns 200 with varbinds and forwards target/port/oids + snmp_params', async () => {
      const exec = vi.fn().mockResolvedValue({
        result: 'success',
        target: '10.0.0.5',
        data: [
          { oid: '1.3.6.1.2.1.1.1.0', type: 'OctetString', value: 'router' },
          { oid: '1.3.6.1.2.1.1.3.0', type: 'TimeTicks', value: 12345 },
        ],
      });
      const { controller } = makeController({ executeSnmpGet: exec });
      const { reply, recorded } = recordingReply();

      await controller.snmpGet(
        {
          target: '10.0.0.5',
          oids: ['1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.1.3.0'],
          version: '2c',
          community: 'public',
        },
        makeRequest(),
        reply,
      );

      expect(recorded.status).toBe(200);
      const body = recorded.body as Record<string, unknown>;
      expect(body.result).toBe('success');
      expect(body.target).toBe('10.0.0.5');
      expect((body.data as unknown[]).length).toBe(2);
      expect(exec).toHaveBeenCalledTimes(1);
      const [target, port, oids, snmpParams] = exec.mock.calls[0];
      expect(target).toBe('10.0.0.5');
      expect(port).toBe(161);
      expect(oids).toEqual(['1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.1.3.0']);
      expect(snmpParams).not.toHaveProperty('target');
      expect(snmpParams).not.toHaveProperty('port');
      expect(snmpParams).not.toHaveProperty('oids');
      expect(snmpParams).not.toHaveProperty('job_id');
      expect((snmpParams as Record<string, unknown>).community).toBe('public');
      expect((snmpParams as Record<string, unknown>).version).toBe('2c');
    });

    it('returns 200 when the service envelope reports result=partial', async () => {
      const exec = vi.fn().mockResolvedValue({
        result: 'partial',
        target: '10.0.0.5',
        data: [{ oid: '1.3.6.1.2.1.1.1.0', type: 'OctetString', value: 'ok' }],
        error: 'one OID timed out',
      });
      const { controller } = makeController({ executeSnmpGet: exec });
      const { reply, recorded } = recordingReply();

      await controller.snmpGet(
        { target: '10.0.0.5', oids: ['1.3.6.1.2.1.1.1.0', '1.3.6.1.2.1.99.0'] },
        makeRequest(),
        reply,
      );

      expect(recorded.status).toBe(200);
      expect((recorded.body as Record<string, unknown>).result).toBe('partial');
    });

    it('returns 400 when the service envelope reports result=failure', async () => {
      const exec = vi.fn().mockResolvedValue({
        result: 'failure',
        target: '10.0.0.5',
        error: 'timeout',
      });
      const { controller } = makeController({ executeSnmpGet: exec });
      const { reply, recorded } = recordingReply();

      await controller.snmpGet({ target: '10.0.0.5', oids: ['1.3.6.1.2.1.1.1.0'] }, makeRequest(), reply);

      expect(recorded.status).toBe(400);
      const body = recorded.body as Record<string, unknown>;
      expect(body.result).toBe('failure');
      expect(body.error).toBe('timeout');
    });

    it('returns 400 when target is missing', async () => {
      const { controller } = makeController();
      const { reply, recorded } = recordingReply();

      await controller.snmpGet({ oids: ['1.3.6.1.2.1.1.1.0'] }, makeRequest(), reply);

      expect(recorded.status).toBe(400);
      expect(JSON.stringify(recorded.body)).toContain('target');
    });

    it('returns 400 when oids is empty (min_length=1)', async () => {
      const { controller } = makeController();
      const { reply, recorded } = recordingReply();

      await controller.snmpGet({ target: '10.0.0.5', oids: [] }, makeRequest(), reply);

      expect(recorded.status).toBe(400);
      expect(JSON.stringify(recorded.body)).toContain('oids');
    });

    it('maps SnmpMonitoringError to 400 with the service message', async () => {
      const exec = vi.fn().mockRejectedValue(new SnmpMonitoringError('auth failed'));
      const { controller } = makeController({ executeSnmpGet: exec });
      const { reply, recorded } = recordingReply();

      await controller.snmpGet({ target: '10.0.0.5', oids: ['1.3.6.1.2.1.1.1.0'] }, makeRequest(), reply);

      expect(recorded.status).toBe(400);
      expect(JSON.stringify(recorded.body)).toContain('auth failed');
    });

    it('returns 500 with a generic message on unexpected errors', async () => {
      const exec = vi.fn().mockRejectedValue(new RangeError('bad params'));
      const { controller } = makeController({ executeSnmpGet: exec });
      const { reply, recorded } = recordingReply();

      await controller.snmpGet({ target: '10.0.0.5', oids: ['1.3.6.1.2.1.1.1.0'] }, makeRequest(), reply);

      expect(recorded.status).toBe(500);
      expect((recorded.body as Record<string, unknown>).error).toBe('Internal server error');
    });
  });

  describe('TestSnmpWalkEndpoint', () => {
    it('returns 200 with the walk envelope and forwards target/port/oid/max + snmp_params', async () => {
      const exec = vi.fn().mockResolvedValue({
        result: 'success',
        target: '10.0.0.5',
        data: [
          { oid: '1.3.6.1.2.1.2.2.1.2.1', type: 'OctetString', value: 'eth0' },
          { oid: '1.3.6.1.2.1.2.2.1.2.2', type: 'OctetString', value: 'eth1' },
          { oid: '1.3.6.1.2.1.2.2.1.2.3', type: 'OctetString', value: 'lo' },
        ],
      });
      const { controller } = makeController({ executeSnmpWalk: exec });
      const { reply, recorded } = recordingReply();

      await controller.snmpWalk(
        {
          target: '10.0.0.5',
          oid: '1.3.6.1.2.1.2.2.1.2',
          max_results: 100,
          version: '2c',
          community: 'public',
        },
        makeRequest(),
        reply,
      );

      expect(recorded.status).toBe(200);
      expect((recorded.body as Record<string, unknown>).result).toBe('success');
      const [target, port, oid, snmpParams, maxResults] = exec.mock.calls[0];
      expect(target).toBe('10.0.0.5');
      expect(port).toBe(161);
      expect(oid).toBe('1.3.6.1.2.1.2.2.1.2');
      expect(maxResults).toBe(100);
      expect(snmpParams).not.toHaveProperty('target');
      expect(snmpParams).not.toHaveProperty('port');
      expect(snmpParams).not.toHaveProperty('oid');
      expect(snmpParams).not.toHaveProperty('max_results');
      expect(snmpParams).not.toHaveProperty('job_id');
      expect((snmpParams as Record<string, unknown>).community).toBe('public');
    });

    it('returns 200 with empty data when the walk finds no OIDs', async () => {
      const exec = vi.fn().mockResolvedValue({
        result: 'success',
        target: '10.0.0.5',
        data: [],
      });
      const { controller } = makeController({ executeSnmpWalk: exec });
      const { reply, recorded } = recordingReply();

      await controller.snmpWalk({ target: '10.0.0.5', oid: '1.3.6.1.2.1.99' }, makeRequest(), reply);

      expect(recorded.status).toBe(200);
      const body = recorded.body as Record<string, unknown>;
      expect(body.result).toBe('success');
      const data = (body.data ?? []) as unknown[];
      expect(data).toEqual([]);
    });

    it('returns 400 when the walk envelope reports result=failure', async () => {
      const exec = vi.fn().mockResolvedValue({
        result: 'failure',
        target: '10.0.0.5',
        error: 'no such oid',
      });
      const { controller } = makeController({ executeSnmpWalk: exec });
      const { reply, recorded } = recordingReply();

      await controller.snmpWalk({ target: '10.0.0.5', oid: '1.3.6.1.2.1.99' }, makeRequest(), reply);

      expect(recorded.status).toBe(400);
      expect((recorded.body as Record<string, unknown>).result).toBe('failure');
    });

    it('returns 400 when oid is missing', async () => {
      const { controller } = makeController();
      const { reply, recorded } = recordingReply();

      await controller.snmpWalk({ target: '10.0.0.5' }, makeRequest(), reply);

      expect(recorded.status).toBe(400);
      expect(JSON.stringify(recorded.body)).toContain('oid');
    });

    it('returns 400 when max_results is below the lower bound', async () => {
      const { controller } = makeController();
      const { reply, recorded } = recordingReply();

      await controller.snmpWalk({ target: '10.0.0.5', oid: '1.3.6.1.2.1.2', max_results: 0 }, makeRequest(), reply);

      expect(recorded.status).toBe(400);
      expect(JSON.stringify(recorded.body)).toContain('max_results');
    });

    it('maps SnmpMonitoringError to 400 with the service message', async () => {
      const exec = vi.fn().mockRejectedValue(new SnmpMonitoringError('engine down'));
      const { controller } = makeController({ executeSnmpWalk: exec });
      const { reply, recorded } = recordingReply();

      await controller.snmpWalk({ target: '10.0.0.5', oid: '1.3.6.1.2.1.2' }, makeRequest(), reply);

      expect(recorded.status).toBe(400);
      expect(JSON.stringify(recorded.body)).toContain('engine down');
    });

    it('returns 500 with a generic message on unexpected errors', async () => {
      const exec = vi.fn().mockRejectedValue(new TypeError('kaboom'));
      const { controller } = makeController({ executeSnmpWalk: exec });
      const { reply, recorded } = recordingReply();

      await controller.snmpWalk({ target: '10.0.0.5', oid: '1.3.6.1.2.1.2' }, makeRequest(), reply);

      expect(recorded.status).toBe(500);
      expect((recorded.body as Record<string, unknown>).error).toBe('Internal server error');
    });
  });
});
