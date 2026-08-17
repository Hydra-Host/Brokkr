import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstValueFrom, type Observable, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AuditEventRow, closeDb } from '../../db/db';
import { AuditStore } from '../../ledger/audit-store';
import { AuditInterceptor } from '../audit.interceptor';
import { labOriginMiddleware, type OriginRequest } from '../lab-context';
import { LabRoute } from '../lab-route';

class FixtureController {
  @LabRoute({ audit: false })
  quiet(): void {}

  @LabRoute({ exposure: 'loopback-only' })
  sharp(): void {}

  plain(): void {}
}

interface RequestFixture {
  method: string;
  path: string;
  body: unknown;
  params: unknown;
  query: unknown;
}

let stateDir: string;
let store: AuditStore;
let interceptor: AuditInterceptor;

function request(over: Partial<RequestFixture> = {}): RequestFixture {
  return { method: 'POST', path: '/api/stack/ops', body: {}, params: {}, query: {}, ...over };
}

function invoke(
  handler: () => void,
  over: Partial<RequestFixture> = {},
  result: Observable<unknown> = of({ ok: true }),
  statusCode = 201,
): Promise<unknown> {
  const ctx = new ExecutionContextHost([request(over), { statusCode }], FixtureController, handler);
  return firstValueFrom(interceptor.intercept(ctx, { handle: () => result }));
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
  stateDir = mkdtempSync(join(tmpdir(), 'lab-audit-interceptor-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
  store = new AuditStore();
  interceptor = new AuditInterceptor(new Reflector(), store);
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('AuditInterceptor default-on coverage', () => {
  it('audits a post carrying no annotation at all', async () => {
    await invoke(FixtureController.prototype.plain);

    expect(onlyRow()).toMatchObject({
      method: 'POST',
      path: '/api/stack/ops',
      handler: 'FixtureController.plain',
      outcome: 'ok',
      status_code: 201,
      error: null,
    });
  });

  it('audits every other mutating verb', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      await invoke(FixtureController.prototype.plain, { method });
    }

    expect(rows().map((row) => row.method).sort()).toEqual(['DELETE', 'PATCH', 'PUT']);
  });

  it('audits a route annotated for exposure but silent about auditing', async () => {
    await invoke(FixtureController.prototype.sharp);

    expect(onlyRow().handler).toBe('FixtureController.sharp');
  });

  it('records a duration and a timestamp', async () => {
    const before = Date.now();

    await invoke(FixtureController.prototype.plain);

    const row = onlyRow();
    expect(row.ts).toBeGreaterThanOrEqual(before);
    expect(row.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

describe('AuditInterceptor exemptions', () => {
  it('does not audit a get', async () => {
    await invoke(FixtureController.prototype.plain, { method: 'GET' });

    expect(rows()).toEqual([]);
  });

  it('does not audit a head', async () => {
    await invoke(FixtureController.prototype.plain, { method: 'HEAD' });

    expect(rows()).toEqual([]);
  });

  it('does not audit an options preflight', async () => {
    await invoke(FixtureController.prototype.plain, { method: 'OPTIONS' });

    expect(rows()).toEqual([]);
  });

  it('does not audit a safe method spelled in lower case', async () => {
    await invoke(FixtureController.prototype.plain, { method: 'head' });
    await invoke(FixtureController.prototype.plain, { method: 'options' });

    expect(rows()).toEqual([]);
  });

  it('still audits a post carrying no annotation once safe methods are exempt', async () => {
    await invoke(FixtureController.prototype.plain, { method: 'POST' });

    expect(onlyRow()).toMatchObject({ method: 'POST', handler: 'FixtureController.plain', outcome: 'ok' });
  });

  it('does not audit a route that opts out with audit false', async () => {
    await invoke(FixtureController.prototype.quiet);

    expect(rows()).toEqual([]);
  });

  it('still returns the handler body on an exempt route', async () => {
    await expect(invoke(FixtureController.prototype.quiet, {}, of({ ok: 'through' }))).resolves.toEqual({
      ok: 'through',
    });
  });
});

describe('AuditInterceptor error outcome', () => {
  it('records the status of a thrown http exception and rethrows it unchanged', async () => {
    const thrown = new NotFoundException("unknown run 'nope'");

    await expect(invoke(FixtureController.prototype.plain, {}, throwError(() => thrown))).rejects.toBe(thrown);

    expect(onlyRow()).toMatchObject({
      outcome: 'error',
      status_code: 404,
      error: "unknown run 'nope'",
      run_id: null,
    });
  });

  it('records the status of each http exception the lab throws', async () => {
    await expect(
      invoke(FixtureController.prototype.plain, {}, throwError(() => new ConflictException('busy'))),
    ).rejects.toThrow(ConflictException);
    await expect(
      invoke(FixtureController.prototype.sharp, {}, throwError(() => new ForbiddenException('loopback only'))),
    ).rejects.toThrow(ForbiddenException);

    expect(rows().map((row) => row.status_code).sort()).toEqual([403, 409]);
  });

  it('falls back to 500 for an error that is not an http exception', async () => {
    await expect(
      invoke(FixtureController.prototype.plain, {}, throwError(() => new Error('database is locked'))),
    ).rejects.toThrow('database is locked');

    expect(onlyRow()).toMatchObject({ outcome: 'error', status_code: 500, error: 'database is locked' });
  });

  it('does not audit a failing get', async () => {
    await expect(
      invoke(FixtureController.prototype.plain, { method: 'GET' }, throwError(() => new NotFoundException('gone'))),
    ).rejects.toThrow(NotFoundException);

    expect(rows()).toEqual([]);
  });
});

describe('AuditInterceptor run id lift', () => {
  it('captures the run id a mutation minted', async () => {
    await invoke(FixtureController.prototype.plain, {}, of({ runId: 'run-7' }));

    expect(onlyRow().run_id).toBe('run-7');
  });

  it('leaves run_id null for a body that names no run', async () => {
    await invoke(FixtureController.prototype.plain, {}, of({ ok: true }));

    expect(onlyRow().run_id).toBeNull();
  });

  it('leaves run_id null for a non-record body and a non-string runId', async () => {
    await invoke(FixtureController.prototype.plain, {}, of('done'));
    await invoke(FixtureController.prototype.plain, {}, of({ runId: 42 }));

    expect(rows().map((row) => row.run_id)).toEqual([null, null]);
  });
});

describe('AuditInterceptor params', () => {
  it('redacts a secret-shaped key but keeps a sharp one verbatim', async () => {
    await invoke(FixtureController.prototype.plain, { body: { password: 'hunter2', sql: 'DROP TABLE runs' } });

    expect(JSON.parse(onlyRow().params!)).toEqual({ password: '***', sql: 'DROP TABLE runs' });
  });

  it('redacts the token a stream url carries in the query', async () => {
    await invoke(FixtureController.prototype.plain, { query: { token: 'sekret-token', section: 'stack' } });

    expect(JSON.parse(onlyRow().params!)).toEqual({ token: '***', section: 'stack' });
  });

  it('combines the body, the path params and the query', async () => {
    await invoke(FixtureController.prototype.plain, {
      body: { opId: 'nuke' },
      params: { runId: 'run-7' },
      query: { follow: 'true' },
    });

    expect(JSON.parse(onlyRow().params!)).toEqual({ opId: 'nuke', runId: 'run-7', follow: 'true' });
  });

  it('leaves params null when the request carries nothing at all', async () => {
    await invoke(FixtureController.prototype.plain);

    expect(onlyRow().params).toBeNull();
  });

  it('tolerates a request whose body is absent or not a record', async () => {
    await invoke(FixtureController.prototype.plain, { body: undefined });
    await invoke(FixtureController.prototype.plain, { body: 'raw text' });

    expect(rows().map((row) => row.params)).toEqual([null, null]);
  });
});

describe('AuditInterceptor origin columns', () => {
  it('records the origin of the request it audits', async () => {
    let pending: Promise<unknown> | undefined;
    const origin: OriginRequest = {
      method: 'POST',
      path: '/api/stack/ops',
      query: {},
      socket: { remoteAddress: '127.0.0.1' },
      headers: {},
    };

    labOriginMiddleware(origin, undefined, () => {
      pending = invoke(FixtureController.prototype.plain);
    });
    await pending;

    expect(onlyRow()).toMatchObject({ origin_ip: '127.0.0.1', origin_loopback: 1, origin_token: 0 });
  });

  it('writes the null triple when there is no request origin in scope', async () => {
    await invoke(FixtureController.prototype.plain);

    expect(onlyRow()).toMatchObject({ origin_ip: null, origin_loopback: null, origin_token: null });
  });
});

describe('AuditInterceptor write failure', () => {
  it('returns the response even when the audit write throws', async () => {
    vi.spyOn(store, 'insert').mockImplementation(() => {
      throw new Error('database is locked');
    });

    await expect(invoke(FixtureController.prototype.plain, {}, of({ runId: 'run-7' }))).resolves.toEqual({
      runId: 'run-7',
    });
  });

  it('still rethrows the handler error when the audit write also throws', async () => {
    vi.spyOn(store, 'insert').mockImplementation(() => {
      throw new Error('database is locked');
    });

    await expect(
      invoke(FixtureController.prototype.plain, {}, throwError(() => new NotFoundException('gone'))),
    ).rejects.toThrow(NotFoundException);
  });
});
