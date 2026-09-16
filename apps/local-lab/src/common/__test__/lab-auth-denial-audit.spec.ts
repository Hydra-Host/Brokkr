import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AuditEventRow, closeDb } from '../../db/db';
import { AuditStore } from '../../ledger/audit-store';
import { LabAuthGuard } from '../lab-auth';
import { labOriginMiddleware, type OriginRequest } from '../lab-context';
import { LabRoute } from '../lab-route';

class FixtureController {
  @LabRoute({ capability: 'host-exec' })
  sharp(): void {}

  plain(): void {}
}

interface RequestFixture {
  method: string;
  path: string;
  ip: string;
  headers: Record<string, string | string[]>;
  body: unknown;
  params: unknown;
  query: Record<string, unknown>;
}

let stateDir: string;
let store: AuditStore;
let guard: LabAuthGuard;

function request(over: Partial<RequestFixture> = {}) {
  const fixture: RequestFixture = {
    method: 'POST',
    path: '/api/stack/ops',
    ip: '10.0.0.5',
    headers: {},
    body: {},
    params: {},
    query: {},
    ...over,
  };
  return { ...fixture, socket: { remoteAddress: fixture.ip } };
}

function contextFor(handler: () => void, over: Partial<RequestFixture> = {}): ExecutionContextHost {
  return new ExecutionContextHost([request(over)], FixtureController, handler);
}

function rows(): AuditEventRow[] {
  return store.list({ limit: 50, offset: 0 }).rows;
}

function onlyRow(): AuditEventRow {
  const all = rows();
  expect(all).toHaveLength(1);
  return all[0]!;
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-auth-denial-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
  store = new AuditStore();
  guard = new LabAuthGuard(new Reflector(), store);
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('LabAuthGuard unauthorized denials', () => {
  it('records a denied row for a remote peer presenting no token', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');

    expect(() => guard.canActivate(contextFor(FixtureController.prototype.plain))).toThrow(UnauthorizedException);

    expect(onlyRow()).toMatchObject({
      method: 'POST',
      path: '/api/stack/ops',
      handler: 'FixtureController.plain',
      outcome: 'denied',
      status_code: 401,
      duration_ms: null,
      run_id: null,
      error: 'lab control API requires a valid lab token for non-loopback requests',
    });
  });

  it('writes exactly one row per denied request', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const ctx = contextFor(FixtureController.prototype.plain);

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);

    expect(rows()).toHaveLength(2);
  });

  it('records the request body and query of the denied attempt, redacted', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const ctx = contextFor(FixtureController.prototype.plain, {
      body: { opId: 'nuke', password: 'hunter2' },
      query: { token: 'guessed-token' },
    });

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);

    expect(JSON.parse(onlyRow().params!)).toEqual({ opId: 'nuke', password: '***', token: '***' });
  });

  it('records the origin of the rejected connection', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const origin: OriginRequest = {
      method: 'POST',
      path: '/api/stack/ops',
      query: {},
      socket: { remoteAddress: '10.0.0.5' },
      headers: {},
    };

    labOriginMiddleware(origin, undefined, () => {
      expect(() => guard.canActivate(contextFor(FixtureController.prototype.plain))).toThrow(UnauthorizedException);
    });

    expect(onlyRow()).toMatchObject({
      origin_ip: '10.0.0.5',
      origin_loopback: 0,
      origin_token: 0,
      origin_principal: null,
    });
  });

  it('names the principal that authenticated but did not authorize', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const headers = { authorization: 'Bearer sekret-token' };
    const origin: OriginRequest = {
      method: 'POST',
      path: '/api/stack/ops',
      query: {},
      socket: { remoteAddress: '10.0.0.5' },
      headers,
    };

    labOriginMiddleware(origin, undefined, () => {
      expect(() => guard.canActivate(contextFor(FixtureController.prototype.sharp, { headers }))).toThrow(
        ForbiddenException,
      );
    });

    expect(onlyRow()).toMatchObject({ origin_token: 1, origin_principal: 'api' });
  });
});

describe('LabAuthGuard capability denials', () => {
  it('records a denied row for an api-token remote peer on a host-exec route', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const ctx = contextFor(FixtureController.prototype.sharp, { headers: { authorization: 'Bearer sekret-token' } });

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);

    expect(onlyRow()).toMatchObject({
      handler: 'FixtureController.sharp',
      outcome: 'denied',
      status_code: 403,
      duration_ms: null,
    });
    expect(onlyRow().error).toMatch(/host-exec/);
  });

  it('records a denied row for a proxy-laundered loopback peer', () => {
    const ctx = contextFor(FixtureController.prototype.sharp, {
      ip: '127.0.0.1',
      headers: { 'x-forwarded-for': '10.0.0.5' },
    });

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);

    expect(onlyRow()).toMatchObject({ outcome: 'denied', status_code: 401 });
  });

  it('records a denied row for a loopback peer in fronted mode', () => {
    vi.stubEnv('LAB_MODE', 'fronted');
    const ctx = contextFor(FixtureController.prototype.sharp, { ip: '127.0.0.1' });

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);

    expect(onlyRow()).toMatchObject({
      outcome: 'denied',
      status_code: 401,
      error:
        'lab control API requires a valid lab token from every caller, loopback included: a terminator dials 127.0.0.1, so a loopback peer is whoever the front door serves',
    });
  });
});

describe('LabAuthGuard allowed requests', () => {
  it('writes nothing when a loopback peer is allowed through', () => {
    expect(guard.canActivate(contextFor(FixtureController.prototype.sharp, { ip: '127.0.0.1' }))).toBe(true);

    expect(rows()).toEqual([]);
  });

  it('writes nothing when the host token admits a remote peer', () => {
    vi.stubEnv('LAB_HOST_TOKEN', 'host-token');
    const ctx = contextFor(FixtureController.prototype.sharp, { headers: { authorization: 'Bearer host-token' } });

    expect(guard.canActivate(ctx)).toBe(true);

    expect(rows()).toEqual([]);
  });
});

describe('LabAuthGuard safe-method denials', () => {
  it('does not record a denied get on an un-annotated route', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');

    expect(() => guard.canActivate(contextFor(FixtureController.prototype.plain, { method: 'GET' }))).toThrow(
      UnauthorizedException,
    );

    expect(rows()).toEqual([]);
  });

  it('does not record a denied head or options on an un-annotated route', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');

    for (const method of ['HEAD', 'OPTIONS', 'head', 'options']) {
      expect(() => guard.canActivate(contextFor(FixtureController.prototype.plain, { method }))).toThrow(
        UnauthorizedException,
      );
    }

    expect(rows()).toEqual([]);
  });

  it('records a denied get on an annotated route', () => {
    const ctx = contextFor(FixtureController.prototype.sharp, {
      method: 'GET',
      ip: '127.0.0.1',
      headers: { 'x-forwarded-for': '10.0.0.5' },
    });

    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);

    expect(onlyRow()).toMatchObject({ method: 'GET', handler: 'FixtureController.sharp', outcome: 'denied' });
  });

  it('records the api token guessing its way through five denied gets before the backoff answers', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const ctx = contextFor(FixtureController.prototype.sharp, {
      method: 'GET',
      headers: { authorization: 'Bearer wrong' },
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    }
    expect(() => guard.canActivate(ctx)).toThrow(/retry in/);

    expect(rows()).toHaveLength(6);
    expect(rows()[0]).toMatchObject({ status_code: 429 });
  });
});

describe('LabAuthGuard denial write failure', () => {
  it('still rejects with 401 when the audit write throws', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    vi.spyOn(store, 'insert').mockImplementation(() => {
      throw new Error('database is locked');
    });

    expect(() => guard.canActivate(contextFor(FixtureController.prototype.plain))).toThrow(UnauthorizedException);
  });

  it('still rejects with 403 when the audit write throws', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    vi.spyOn(store, 'insert').mockImplementation(() => {
      throw new Error('database is locked');
    });
    const ctx = contextFor(FixtureController.prototype.sharp, { headers: { authorization: 'Bearer sekret-token' } });

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('does not surface the write failure to the caller', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    vi.spyOn(store, 'insert').mockImplementation(() => {
      throw new Error('database is locked');
    });

    expect(() => guard.canActivate(contextFor(FixtureController.prototype.plain))).not.toThrow('database is locked');
  });
});
