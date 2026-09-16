import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LabAuthGuard } from '../../common/lab-auth';
import { AuditStore } from '../../ledger/audit-store';
import { HealthController } from '../health.controller';

let guard: LabAuthGuard;

beforeEach(() => {
  guard = new LabAuthGuard(new Reflector(), new AuditStore());
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function contextFor(peer: string) {
  const req = { method: 'GET', path: '/api/health', ip: peer, socket: { remoteAddress: peer }, headers: {}, query: {} };
  return new ExecutionContextHost([req], HealthController, HealthController.prototype.health);
}

describe('HealthController', () => {
  it('returns a body with exactly one key', () => {
    const body = new HealthController().health();
    expect(body).toEqual({ status: 'ok' });
    expect(Object.keys(body)).toEqual(['status']);
  });
});

describe('LabAuthGuard on the health route', () => {
  it('admits a remote peer holding no token', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    expect(guard.canActivate(contextFor('10.0.0.5'))).toBe(true);
  });

  it('admits a remote peer holding no token in fronted mode', () => {
    vi.stubEnv('LAB_MODE', 'fronted');
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    expect(guard.canActivate(contextFor('10.0.0.5'))).toBe(true);
  });

  it('admits a loopback peer in fronted mode, where every other route needs a token', () => {
    vi.stubEnv('LAB_MODE', 'fronted');
    expect(guard.canActivate(contextFor('127.0.0.1'))).toBe(true);
  });
});
