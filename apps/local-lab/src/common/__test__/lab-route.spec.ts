import { Controller, ForbiddenException, UnauthorizedException } from '@nestjs/common';
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
  @LabRoute({ exposure: 'loopback-only' })
  sharp() {}

  @TsRestHandler(contract.getGettingStarted)
  plain() {}
}

const multiRouter = initContract().router({
  only: { method: 'GET', path: '/fixture/multi/only', responses: { 200: z.object({ ok: z.boolean() }) } },
});

@Controller()
class TagBelowController {
  declare handler_only: () => unknown;

  @TsRestHandler(multiRouter)
  @LabRoute({ exposure: 'loopback-only' })
  handler() {}
}

@Controller()
class TagAboveController {
  declare handler_only: () => unknown;

  @LabRoute({ exposure: 'loopback-only' })
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
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('LabRoute metadata alongside TsRestHandler', () => {
  it('resolves off the annotated method through a container Reflector', () => {
    const opts = reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, FixtureController.prototype.sharp);
    expect(opts).toEqual({ exposure: 'loopback-only' });
  });

  it('is absent on an un-annotated method', () => {
    expect(reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, FixtureController.prototype.plain)).toBeUndefined();
  });

  it('copies the tag onto the virtual method when LabRoute sits below TsRestHandler', () => {
    expect(typeof TagBelowController.prototype.handler_only).toBe('function');
    expect(reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, TagBelowController.prototype.handler_only)).toEqual({
      exposure: 'loopback-only',
    });
  });

  it('drops the tag when LabRoute sits above TsRestHandler on a multi-route handler', () => {
    expect(typeof TagAboveController.prototype.handler_only).toBe('function');
    expect(
      reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, TagAboveController.prototype.handler_only),
    ).toBeUndefined();
    expect(reflector.get<LabRouteOptions | undefined>(LAB_ROUTE, TagAboveController.prototype.handler)).toEqual({
      exposure: 'loopback-only',
    });
  });
});

describe('LabAuthGuard on a loopback-only route', () => {
  it('allows a loopback peer with no token configured', () => {
    expect(guard.canActivate(contextFor(FixtureController.prototype.sharp, '127.0.0.1'))).toBe(true);
  });

  it('forbids a remote peer that presents a valid token', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const ctx = contextFor(FixtureController.prototype.sharp, '10.0.0.5', { authorization: 'Bearer sekret-token' });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx)).toThrow(/LAB_ALLOW_REMOTE_SHARP/);
  });

  it('rejects a remote peer with no token as unauthorized, not forbidden', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const ctx = contextFor(FixtureController.prototype.sharp, '10.0.0.5');
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctx)).not.toThrow(ForbiddenException);
  });

  it('forbids a proxy-laundered caller whose forwarded hop is not loopback', () => {
    const ctx = contextFor(FixtureController.prototype.sharp, '127.0.0.1', { 'x-forwarded-for': '10.0.0.5' });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('allows a remote peer once the opt-in is set and the token matches', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    vi.stubEnv('LAB_ALLOW_REMOTE_SHARP', '1');
    const ctx = contextFor(FixtureController.prototype.sharp, '10.0.0.5', { authorization: 'Bearer sekret-token' });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});

describe('LabAuthGuard on an un-annotated route', () => {
  it('keeps the loopback-or-token behavior unchanged', () => {
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

  it('is not tightened by a forwarded hop that would fail a loopback-only route', () => {
    const ctx = contextFor(FixtureController.prototype.plain, '127.0.0.1', { 'x-forwarded-for': '10.0.0.5' });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
