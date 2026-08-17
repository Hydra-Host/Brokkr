import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminModule } from '../admin.module.js';
import type { CronStateProvider } from '../cron-state.js';
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

describe('CronsController', () => {
  describe('with the default empty provider', () => {
    let controller: CronsController;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AdminModule] }).compile();
      controller = moduleRef.get(CronsController);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns the empty-list bytes when no cron supervisor is wired', () => {
      const { res, recorded } = recordingResponse();
      controller.listCrons(res as never);
      expect(recorded.status).toBe(200);
      expect(recorded.headers['Content-Type']).toBe('application/json');
      expect(recorded.body?.toString('utf8')).toBe('[]\n');
    });
  });

  describe('with a wired provider', () => {
    let controller: CronsController;
    const lastRun = new Date('2026-06-12T10:00:00.000Z');
    const nextRun = new Date('2026-06-12T10:05:00.000Z');

    const provider: CronStateProvider = {
      states: () => [
        {
          name: 'asset-sync',
          intervalSeconds: 300,
          lastRunAt: lastRun,
          lastSuccessAt: null,
          nextRunAt: nextRun,
          lastError: "RuntimeError('sync failed')",
          consecutiveFailures: 2,
          running: false,
        },
      ],
    };

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AdminModule] })
        .overrideProvider(CRON_STATE_PROVIDER)
        .useValue(provider)
        .compile();
      controller = moduleRef.get(CronsController);
    });

    it('renders the wire object with the canonical byte layout', () => {
      const { res, recorded } = recordingResponse();
      controller.listCrons(res as never);
      const expected =
        '[{' +
        '"consecutive_failures":2,' +
        '"interval_seconds":300.0,' +
        '"last_error":"RuntimeError(\'sync failed\')",' +
        '"last_run_at":"2026-06-12T10:00:00+00:00",' +
        '"last_success_at":null,' +
        '"name":"asset-sync",' +
        '"next_run_at":"2026-06-12T10:05:00+00:00",' +
        '"running":false' +
        '}]\n';
      expect(recorded.status).toBe(200);
      expect(recorded.headers['Content-Type']).toBe('application/json');
      expect(recorded.body?.toString('utf8')).toBe(expected);
    });
  });
});
