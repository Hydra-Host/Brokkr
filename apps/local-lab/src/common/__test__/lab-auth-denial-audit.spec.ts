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
  @LabRoute({ exposure: 'loopback-only' })
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
      error: 'lab control API requires a valid LAB_API_TOKEN for non-loopback requests',
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

    expect(onlyRow()).toMatchObject({ origin_ip: '10.0.0.5', origin_loopback: 0, origin_token: 0 });
  });
});

describe('LabAuthGuard exposure denials', () => {
  it('records a denied row for a token-bearing remote peer on a loopback-only route', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const ctx = contextFor(FixtureController.prototype.sharp, { headers: { authorization: 'Bearer sekret-token' } });

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);

    expect(onlyRow()).toMatchObject({
      handler: 'FixtureController.sharp',
      outcome: 'denied',
      status_code: 403,
      duration_ms: null,
    });
    expect(onlyRow().error).toMatch(/loopback-only/);
  });

  it('records a denied row for a proxy-laundered loopback peer', () => {
    const ctx = contextFor(FixtureController.prototype.sharp, {
      ip: '127.0.0.1',
      headers: { 'x-forwarded-for': '10.0.0.5' },
    });

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);

    expect(onlyRow()).toMatchObject({ outcome: 'denied', status_code: 403 });
  });

  it('rethrows the forbidden exception unchanged', () => {
    const ctx = contextFor(FixtureController.prototype.sharp, {
      ip: '127.0.0.1',
      headers: { 'x-forwarded-for': '10.0.0.5' },
    });

    expect(() => guard.canActivate(ctx)).toThrow(/LAB_ALLOW_REMOTE_SHARP/);
  });
});

describe('LabAuthGuard allowed requests', () => {
  it('writes nothing when a loopback peer is allowed through', () => {
    expect(guard.canActivate(contextFor(FixtureController.prototype.sharp, { ip: '127.0.0.1' }))).toBe(true);

    expect(rows()).toEqual([]);
  });

  it('writes nothing when the remote-sharp opt-in allows a token-bearing peer', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    vi.stubEnv('LAB_ALLOW_REMOTE_SHARP', '1');
    const ctx = contextFor(FixtureController.prototype.sharp, { headers: { authorization: 'Bearer sekret-token' } });

    expect(guard.canActivate(ctx)).toBe(true);

    expect(rows()).toEqual([]);
  });
});

describe('LabAuthGuard safe-method denials', () => {
  it('does not record a denied get', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');

    expect(() => guard.canActivate(contextFor(FixtureController.prototype.plain, { method: 'GET' }))).toThrow(
      UnauthorizedException,
    );

    expect(rows()).toEqual([]);
  });

  it('does not record a denied head or options, whatever the case', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');

    for (const method of ['HEAD', 'OPTIONS', 'head', 'options']) {
      expect(() => guard.canActivate(contextFor(FixtureController.prototype.plain, { method }))).toThrow(
        UnauthorizedException,
      );
    }

    expect(rows()).toEqual([]);
  });

  it('does not record a get denied by the exposure rule', () => {
    const ctx = contextFor(FixtureController.prototype.sharp, {
      method: 'GET',
      ip: '127.0.0.1',
      headers: { 'x-forwarded-for': '10.0.0.5' },
    });

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);

    expect(rows()).toEqual([]);
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
    vi.spyOn(store, 'insert').mockImplementation(() => {
      throw new Error('database is locked');
    });
    const ctx = contextFor(FixtureController.prototype.sharp, {
      ip: '127.0.0.1',
      headers: { 'x-forwarded-for': '10.0.0.5' },
    });

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
