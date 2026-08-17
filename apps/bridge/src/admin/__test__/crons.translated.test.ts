import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { AdminModule } from '../admin.module.js';
import type { CronStateProvider, CronStateSnapshot } from '../cron-state.js';
import { CRON_STATE_PROVIDER } from '../cron-state.js';
import { CronsController } from '../crons.controller.js';

interface RecordedResponse {
  status: number | null;
  headers: Record<string, string>;
  body: Buffer | null;
}

function recordingResponse(): { res: unknown; recorded: RecordedResponse } {
  const recorded: RecordedResponse = { status: null, headers: {}, body: null };
  const res = {
    status(code: number) {
      recorded.status = code;
      return this;
    },
    setHeader(name: string, value: string) {
      recorded.headers[name] = value;
      return this;
    },
    send(body: Buffer) {
      recorded.body = body;
      return this;
    },
  };
  return { res, recorded };
}

function parseBody(recorded: RecordedResponse): unknown {
  return JSON.parse(recorded.body!.toString('utf8'));
}

async function buildController(provider: CronStateProvider | null): Promise<CronsController> {
  const builder = Test.createTestingModule({ imports: [AdminModule] });
  const moduleRef = provider
    ? await builder.overrideProvider(CRON_STATE_PROVIDER).useValue(provider).compile()
    : await builder.compile();
  return moduleRef.get(CronsController);
}

describe('routes/admin — crons', () => {
  it('returns [] when the supervisor has no started tasks', async () => {
    const provider: CronStateProvider = { states: () => [] };
    const controller = await buildController(provider);
    const { res, recorded } = recordingResponse();
    controller.listCrons(res as never);
    expect(recorded.status).toBe(200);
    expect(parseBody(recorded)).toEqual([]);
  });

  it('stays 200 with [] body when no supervisor provider has been wired', async () => {
    const controller = await buildController(null);
    const { res, recorded } = recordingResponse();
    controller.listCrons(res as never);
    expect(recorded.status).toBe(200);
    expect(parseBody(recorded)).toEqual([]);
  });

  describe('with a single registered cron', () => {
    let controller: CronsController;

    beforeEach(async () => {
      const snapshot: CronStateSnapshot = {
        name: 'hello',
        intervalSeconds: 30,
        lastRunAt: null,
        lastSuccessAt: null,
        nextRunAt: null,
        lastError: null,
        consecutiveFailures: 0,
        running: false,
      };
      controller = await buildController({ states: () => [snapshot] });
    });

    it('renders the cron with the documented field shape', () => {
      const { res, recorded } = recordingResponse();
      controller.listCrons(res as never);
      expect(recorded.status).toBe(200);
      const body = parseBody(recorded) as Array<Record<string, unknown>>;
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
      const entry = body[0];
      expect(entry.name).toBe('hello');
      expect(entry.interval_seconds).toBe(30.0);
      expect(entry).toHaveProperty('last_run_at');
      expect(entry).toHaveProperty('last_success_at');
      expect(entry).toHaveProperty('next_run_at');
      expect(entry).toHaveProperty('last_error');
      expect(entry).toHaveProperty('consecutive_failures');
      expect(entry).toHaveProperty('running');
    });
  });

  it('renders last_run_at / last_success_at / next_run_at as ISO-8601 with +00:00', async () => {
    const fixed = new Date(Date.UTC(2030, 0, 2, 3, 4, 5));
    const snapshot: CronStateSnapshot = {
      name: 'iso',
      intervalSeconds: 10,
      lastRunAt: fixed,
      lastSuccessAt: fixed,
      nextRunAt: fixed,
      lastError: null,
      consecutiveFailures: 0,
      running: false,
    };
    const controller = await buildController({ states: () => [snapshot] });
    const { res, recorded } = recordingResponse();
    controller.listCrons(res as never);
    const body = parseBody(recorded) as Array<Record<string, unknown>>;
    const entry = body[0];
    expect(entry.last_run_at).toBe('2030-01-02T03:04:05+00:00');
    expect(entry.last_success_at).toBe('2030-01-02T03:04:05+00:00');
    expect(entry.next_run_at).toBe('2030-01-02T03:04:05+00:00');
  });

  it('registers CronsController via AdminModule and exposes CRON_STATE_PROVIDER', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AdminModule] }).compile();
    expect(moduleRef.get(CronsController)).toBeInstanceOf(CronsController);
    expect(moduleRef.get(CRON_STATE_PROVIDER)).toBeDefined();
  });
});
