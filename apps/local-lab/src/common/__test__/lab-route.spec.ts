import { Controller, ForbiddenException, HttpException, Logger, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { Test } from '@nestjs/testing';
import { initContract } from '@ts-rest/core';
import { TsRestHandler } from '@ts-rest/nest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach } from 'vitest';
import { z } from 'zod';

import { contract } from '../../contract';
import { closeDb } from '../../db/db';
import { AuditStore } from '../../ledger/audit-store';
import { LabAuthGuard } from '../lab-auth';
import { LAB_ROUTE, LabRoute, type LabRouteOptions } from '../lab-route';

@Controller()
class FixtureController {
  @TsRestHandler(contract.getStatus)
  @LabRoute({ capability: 'host-exec' })
  sharp() {}

  @TsRestHandler(contract.listServices)
  plain() {}

  @TsRestHandler(contract.listRuns)
  @LabRoute({ capability: 'per-run' })
  perRun() {}
}

const multiRouter = initContract().router({
  only: { method: 'GET', path: '/fixture/multi/only', responses: { 200: z.object({ ok: z.boolean() }) } },
});

@Controller()
class TagBelowController {
  declare handler_only: () => unknown;

  @TsRestHandler(multiRouter)
  @LabRoute({ capability: 'host-exec' })
  handler() {}
}

@Controller()
class TagAboveController {
  declare handler_only: () => unknown;

  @LabRoute({ capability: 'host-exec' })
  @TsRestHandler(multiRouter)
  handler() {}
}

function requestFor(peer: string, headers: Record<string, string | string[]> = {}) {
  return { method: 'POST', path: '/api/fixture', ip: peer, socket: { remoteAddress: peer }, headers, query: {} };
}

function contextFor(handler: () => void, peer: string, headers?: Record<string, string | string[]>) {
  return new ExecutionContextHost([requestFor(peer, headers)], FixtureController, handler);
}

let reflector: Reflector;
let guard: LabAuthGuard;
let stateDir: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [FixtureController, TagBelowController, TagAboveController],
  }).compile();
  reflector = moduleRef.get(Reflector, { strict: false });
});

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-route-guard-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
  guard = new LabAuthGuard(reflector, new AuditStore());
});

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('LabRoute capability metadata alongside TsRestHandler', () => {
  it('resolves off the annotated method through a container Reflector', () => {
    const opts = reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, FixtureController.prototype.sharp);
    expect(opts).toEqual({ capability: 'host-exec' });
  });

  it('is absent on an un-annotated method', () => {
    expect(reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, FixtureController.prototype.plain)).toBeUndefined();
  });

  it('copies the tag onto the virtual method when LabRoute sits below TsRestHandler', () => {
    expect(typeof TagBelowController.prototype.handler_only).toBe('function');
    expect(reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, TagBelowController.prototype.handler_only)).toEqual({
      capability: 'host-exec',
    });
  });

  it('drops the tag when LabRoute sits above TsRestHandler on a multi-route handler', () => {
    expect(typeof TagAboveController.prototype.handler_only).toBe('function');
    expect(
      reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, TagAboveController.prototype.handler_only),
    ).toBeUndefined();
    expect(reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, TagAboveController.prototype.handler)).toEqual({
      capability: 'host-exec',
    });
  });
});

describe('LabAuthGuard on a host-exec route', () => {
  it('allows a loopback peer with no token configured', () => {
    expect(guard.canActivate(contextFor(FixtureController.prototype.sharp, '127.0.0.1'))).toBe(true);
  });

  it('forbids a remote peer that presents the api token', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const ctx = contextFor(FixtureController.prototype.sharp, '10.0.0.5', { authorization: 'Bearer sekret-token' });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx)).toThrow(/host-exec/);
  });

  it('rejects a remote peer with no token as unauthorized, not forbidden', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const ctx = contextFor(FixtureController.prototype.sharp, '10.0.0.5');
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctx)).not.toThrow(ForbiddenException);
  });

  it('forbids a proxy-laundered caller whose forwarded hop is not loopback', () => {
    const ctx = contextFor(FixtureController.prototype.sharp, '127.0.0.1', { 'x-forwarded-for': '10.0.0.5' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('allows a remote peer holding the host token', () => {
    vi.stubEnv('LAB_HOST_TOKEN', 'host-token');
    const ctx = contextFor(FixtureController.prototype.sharp, '10.0.0.5', { authorization: 'Bearer host-token' });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});

describe('LabAuthGuard on an un-annotated route', () => {
  it('requires read, which loopback or any valid token satisfies', () => {
    expect(guard.canActivate(contextFor(FixtureController.prototype.plain, '127.0.0.1'))).toBe(true);
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const withToken = contextFor(FixtureController.prototype.plain, '10.0.0.5', {
      authorization: 'Bearer sekret-token',
    });
    expect(guard.canActivate(withToken)).toBe(true);
    expect(() => guard.canActivate(contextFor(FixtureController.prototype.plain, '10.0.0.5'))).toThrow(
      UnauthorizedException,
    );
  });

  it('is tightened by a forwarded hop just as an annotated route is', () => {
    const ctx = contextFor(FixtureController.prototype.plain, '127.0.0.1', { 'x-forwarded-for': '10.0.0.5' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});

describe('LabAuthGuard in fronted mode', () => {
  it('refuses a loopback peer holding no token', () => {
    vi.stubEnv('LAB_MODE', 'fronted');
    expect(() => guard.canActivate(contextFor(FixtureController.prototype.plain, '127.0.0.1'))).toThrow(
      UnauthorizedException,
    );
  });

  it('admits a loopback peer holding the api token on a read route', () => {
    vi.stubEnv('LAB_MODE', 'fronted');
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const ctx = contextFor(FixtureController.prototype.plain, '127.0.0.1', { authorization: 'Bearer sekret-token' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('refuses the api token on a host-exec route even from loopback', () => {
    vi.stubEnv('LAB_MODE', 'fronted');
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const ctx = contextFor(FixtureController.prototype.sharp, '127.0.0.1', { authorization: 'Bearer sekret-token' });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});

describe('LabAuthGuard per-address backoff', () => {
  it('answers 429 once one address has been rejected five times', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const ctx = contextFor(FixtureController.prototype.plain, '10.0.0.5', { authorization: 'Bearer wrong' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    }
    expect(() => guard.canActivate(ctx)).toThrow(/retry in \d+s/);
    try {
      guard.canActivate(ctx);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      if (error instanceof HttpException) expect(error.getStatus()).toBe(429);
    }
  });

  it('leaves another address untouched', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const rejected = contextFor(FixtureController.prototype.plain, '10.0.0.5', { authorization: 'Bearer wrong' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() => guard.canActivate(rejected)).toThrow(UnauthorizedException);
    }
    const other = contextFor(FixtureController.prototype.plain, '10.0.0.9', { authorization: 'Bearer sekret-token' });
    expect(guard.canActivate(other)).toBe(true);
  });

  it('keeps counting rejections across a valid token presented from the same address', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const wrong = contextFor(FixtureController.prototype.plain, '10.0.0.5', { authorization: 'Bearer wrong' });
    const right = contextFor(FixtureController.prototype.plain, '10.0.0.5', { authorization: 'Bearer sekret-token' });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(() => guard.canActivate(wrong)).toThrow(UnauthorizedException);
    }

    expect(guard.canActivate(right)).toBe(true);

    expect(() => guard.canActivate(wrong)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(right)).toThrow(/retry in \d+s/);
  });

  it('does not let a patient guesser wait out the counter between rounds', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const wrong = contextFor(FixtureController.prototype.plain, '10.0.0.5', { authorization: 'Bearer wrong' });
    vi.useFakeTimers();
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect(() => guard.canActivate(wrong)).toThrow(UnauthorizedException);
      }

      vi.advanceTimersByTime(31_000);

      expect(() => guard.canActivate(wrong)).toThrow(UnauthorizedException);
      expect(() => guard.canActivate(wrong)).toThrow(/retry in \d+s/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets a stale run of guesses once the address has been idle long enough', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const wrong = contextFor(FixtureController.prototype.plain, '10.0.0.5', { authorization: 'Bearer wrong' });
    const right = contextFor(FixtureController.prototype.plain, '10.0.0.5', { authorization: 'Bearer sekret-token' });
    vi.useFakeTimers();
    try {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect(() => guard.canActivate(wrong)).toThrow(UnauthorizedException);
      }

      vi.advanceTimersByTime(10 * 30_000 + 1_000);

      for (let attempt = 0; attempt < 4; attempt += 1) {
        expect(() => guard.canActivate(wrong)).toThrow(UnauthorizedException);
      }
      expect(guard.canActivate(right)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never rate-limits a caller the loopback grant admits', () => {
    const ctx = contextFor(FixtureController.prototype.plain, '127.0.0.1');
    for (let attempt = 0; attempt < 20; attempt += 1) expect(guard.canActivate(ctx)).toBe(true);
  });

  it('never rate-limits the blank x-lab-token a token-less lab-web sends on every call', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const blank = contextFor(FixtureController.prototype.plain, '10.0.0.5', { 'x-lab-token': '' });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect(() => guard.canActivate(blank)).toThrow(UnauthorizedException);
    }
    const pasted = contextFor(FixtureController.prototype.plain, '10.0.0.5', {
      authorization: 'Bearer sekret-token',
    });
    expect(guard.canActivate(pasted)).toBe(true);
  });
});

describe('LabAuthGuard when both tokens hold the same value', () => {
  it('refuses the injected token rather than promoting it to host-exec', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    vi.stubEnv('LAB_API_TOKEN', 'same-token');
    vi.stubEnv('LAB_HOST_TOKEN', 'same-token');
    const ctx = contextFor(FixtureController.prototype.sharp, '10.0.0.5', { authorization: 'Bearer same-token' });
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});

describe('LabAuthGuard on a per-run route', () => {
  it('admits a loopback caller at the read floor', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');

    expect(guard.canActivate(contextFor(FixtureController.prototype.perRun, '127.0.0.1'))).toBe(true);
  });

  it('admits a remote caller holding only the api token, leaving the run gate to decide', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    vi.stubEnv('LAB_HOST_TOKEN', 'host-token');

    const ctx = contextFor(FixtureController.prototype.perRun, '10.0.0.5', {
      authorization: 'Bearer sekret-token',
    });

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('still refuses a remote caller with no token at all', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');

    expect(() => guard.canActivate(contextFor(FixtureController.prototype.perRun, '10.0.0.5'))).toThrow(
      UnauthorizedException,
    );
  });
});
