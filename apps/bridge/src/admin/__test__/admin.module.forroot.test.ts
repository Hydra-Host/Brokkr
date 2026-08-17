import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { AdminModule } from '../admin.module.js';
import {
  CRON_STATE_PROVIDER,
  type CronStateProvider,
  type CronStateSnapshot,
  type CronStateSupervisorLike,
} from '../cron-state.js';
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

describe('AdminModule.forRoot', () => {
  it('defaults to the empty provider when no supervisor is supplied', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AdminModule.forRoot()],
    }).compile();
    const provider = moduleRef.get<CronStateProvider>(CRON_STATE_PROVIDER);
    expect(provider.states()).toEqual([]);
  });

  it('binds CRON_STATE_PROVIDER to the supplied supervisor instance', async () => {
    const snapshot: CronStateSnapshot = {
      name: 'snmp-recycle',
      intervalSeconds: 60,
      lastRunAt: null,
      lastSuccessAt: null,
      nextRunAt: null,
      lastError: null,
      consecutiveFailures: 0,
      running: false,
    };
    const supervisor: CronStateSupervisorLike = { states: () => [snapshot] };
    const moduleRef = await Test.createTestingModule({
      imports: [AdminModule.forRoot({ cronSupervisor: supervisor })],
    }).compile();
    const provider = moduleRef.get<CronStateProvider>(CRON_STATE_PROVIDER);
    expect(provider.states()).toEqual([snapshot]);
  });

  it('resolves a supervisor factory lazily at provider construction', async () => {
    const snapshot: CronStateSnapshot = {
      name: 'leader-heartbeat',
      intervalSeconds: 5,
      lastRunAt: null,
      lastSuccessAt: null,
      nextRunAt: null,
      lastError: null,
      consecutiveFailures: 0,
      running: true,
    };
    let factoryCalls = 0;
    const factory = (): CronStateSupervisorLike => {
      factoryCalls += 1;
      return { states: () => [snapshot] };
    };
    const moduleRef = await Test.createTestingModule({
      imports: [AdminModule.forRoot({ cronSupervisor: factory })],
    }).compile();
    const provider = moduleRef.get<CronStateProvider>(CRON_STATE_PROVIDER);
    expect(factoryCalls).toBe(1);
    expect(provider.states()).toEqual([snapshot]);
  });

  it('renders supervisor-backed state through CronsController', async () => {
    const snapshot: CronStateSnapshot = {
      name: 'snmp-recycle',
      intervalSeconds: 60,
      lastRunAt: null,
      lastSuccessAt: null,
      nextRunAt: null,
      lastError: null,
      consecutiveFailures: 0,
      running: false,
    };
    const supervisor: CronStateSupervisorLike = { states: () => [snapshot] };
    const moduleRef = await Test.createTestingModule({
      imports: [AdminModule.forRoot({ cronSupervisor: supervisor })],
    }).compile();
    const controller = moduleRef.get(CronsController);
    const { res, recorded } = recordingResponse();
    controller.listCrons(res as never);
    const expected =
      '[{' +
      '"consecutive_failures":0,' +
      '"interval_seconds":60.0,' +
      '"last_error":null,' +
      '"last_run_at":null,' +
      '"last_success_at":null,' +
      '"name":"snmp-recycle",' +
      '"next_run_at":null,' +
      '"running":false' +
      '}]\n';
    expect(recorded.status).toBe(200);
    expect(recorded.body?.toString('utf8')).toBe(expected);
  });
});
