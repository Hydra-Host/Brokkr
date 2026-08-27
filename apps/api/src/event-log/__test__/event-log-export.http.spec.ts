import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { contract, type EventLogEntry } from '@repo/api-client';
import type { Server } from 'http';
import { DesignationOperatorPolicy, OPERATOR_POLICY } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CSV_TRAILER_PREFIX, EventLogExportService } from '../event-log-export.service';
import { EventLogRepository } from '../event-log.repository';
import { EventLogController } from '../event-log.controller';
import { EventLogService } from '../event-log.service';

const EXPORT_PATH = contract.exportEventLog.path;

function entry(id: string): EventLogEntry {
  return {
    id,
    tier: 'ACTIVITY',
    durability: 'BEST_EFFORT',
    resource: 'device',
    action: 'update',
    actionKey: 'device.update',
    actorType: 'UI',
    actorId: 'u-1',
    actorLabel: 'admin@example.com',
    apiKeyId: null,
    apiKeyLabel: null,
    targetId: null,
    targetLabel: null,
    outcome: 'SUCCEEDED',
    errorCode: null,
    requestId: 'req-1',
    method: 'PATCH',
    path: '/api/v1/devices/1',
    ipAddress: '203.0.113.9',
    userAgent: 'vitest',
    metadata: null,
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
  };
}

describe('event-log export (HTTP)', () => {
  let app: INestApplication;
  let server: Server;
  let findAfterKey: ReturnType<typeof vi.fn>;
  let countAfterKey: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    findAfterKey = vi.fn();
    countAfterKey = vi.fn().mockResolvedValue(2);

    const moduleRef = await Test.createTestingModule({
      controllers: [EventLogController],
      providers: [
        ContextService,
        { provide: OPERATOR_POLICY, useClass: DesignationOperatorPolicy },
        { provide: EventLogRepository, useValue: { findAfterKey, countAfterKey, findOldestKey: vi.fn() } },
        { provide: EventLogService, useValue: { list: vi.fn(), recordExport: vi.fn().mockResolvedValue(undefined) } },
        {
          provide: EventLogExportService,
          inject: [EventLogRepository, EventLogService, ContextService],
          useFactory: (repository: EventLogRepository, eventLog: EventLogService, context: ContextService) =>
            new EventLogExportService(
              repository,
              eventLog,
              context,
              { get: () => undefined } as never,
              { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() } as never,
            ),
        },
      ],
    }).compile();

    const contextService = moduleRef.get(ContextService);
    app = moduleRef.createNestApplication();
    app.use((_req: unknown, _res: unknown, next: () => void) => {
      contextService.run(
        {
          requestId: 'test-req',
          identity: {
            authType: 'session',
            organizationId: 'org-1',
            organization: { id: 'org-1' },
            permissions: new Set(['event-log:access']),
            session: { user: { id: 'u-1', email: 'caller@example.com' } },
          },
        } as never,
        next,
      );
    });
    await app.init();
    server = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves a complete csv download with the truncation header', async () => {
    findAfterKey.mockResolvedValueOnce([entry('a'), entry('b')]).mockResolvedValueOnce([]);

    const response = await request(server).get(EXPORT_PATH).query({ format: 'csv' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['x-event-log-truncated']).toBe('false');
    expect(response.headers['content-disposition']).toContain('attachment; filename="event-log-org-1-');
    expect(response.text.trimEnd().split('\n').at(-1)).toBe(`${CSV_TRAILER_PREFIX} rows=2 truncated=false limit=50000`);
  });

  it('aborts the response instead of ending a half file when the scan fails mid-stream', async () => {
    findAfterKey
      .mockResolvedValueOnce([entry('a'), entry('b')])
      .mockRejectedValueOnce(new Error('connection reset mid-scan'));

    const failure = await request(server)
      .get(EXPORT_PATH)
      .query({ format: 'csv' })
      .then(() => undefined)
      .catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/aborted|socket hang up|ECONNRESET/i);
  });

  it('answers a pre-stream failure with a json error and no partial file', async () => {
    countAfterKey.mockRejectedValueOnce(new Error('database is down'));

    const response = await request(server).get(EXPORT_PATH).query({ format: 'csv' });

    expect(response.status).toBe(500);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toEqual({ statusCode: 500, message: 'Event log export failed' });
  });

  it('serves a keyset json page on the same route', async () => {
    findAfterKey.mockResolvedValueOnce([entry('a')]);

    const response = await request(server).get(EXPORT_PATH).query({ format: 'json', pageSize: '1' });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body.data.map((row: EventLogEntry) => row.id)).toEqual(['a']);
    expect(response.body.hasMore).toBe(true);
  });

  it('rejects a query the contract schema does not accept', async () => {
    const response = await request(server).get(EXPORT_PATH).query({ format: 'xml' });

    expect(response.status).toBe(400);
  });
});
