import { Module, type INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { isRecord } from '@repo/utils';

import { LabAuthGuard } from '../../common/lab-auth';
import { LabExceptionFilter } from '../../common/lab-exception.filter';
import { AuditStore } from '../../ledger/audit-store';
import { DocsModule } from '../docs.module';

@Module({
  imports: [DocsModule],
  providers: [
    { provide: APP_GUARD, useClass: LabAuthGuard },
    { provide: APP_FILTER, useClass: LabExceptionFilter },
    AuditStore,
  ],
})
class SpecModule {}

const ORIG = { ...process.env };
const TOKEN = 'lab-token-for-specs';
const REMOTE = '198.51.100.9';
const DOCS_PATHS = ['/api/swagger-json', '/api/redoc', '/api/swagger'];

let app: INestApplication;
let base: string;

function offLoopback(headers: Record<string, string> = {}): RequestInit {
  return { headers: { 'x-forwarded-for': REMOTE, ...headers } };
}

beforeAll(async () => {
  app = await NestFactory.create(SpecModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const addr: unknown = app.getHttpServer().address();
  if (typeof addr !== 'object' || addr === null || !('port' in addr)) throw new Error('expected an AddressInfo');
  base = `http://127.0.0.1:${String(addr.port)}`;
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  process.env = { ...ORIG };
});

describe('ApiDocsController', () => {
  beforeEach(() => {
    process.env.LAB_TRUST_PROXY = '1';
    process.env.LAB_API_TOKEN = TOKEN;
  });

  it.each(DOCS_PATHS)('rejects %s from a non-loopback client without a token', async (path) => {
    const res = await fetch(`${base}${path}`, offLoopback());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: 'lab control API requires a valid LAB_API_TOKEN for non-loopback requests',
    });
  });

  it.each(DOCS_PATHS)('rejects %s from a non-loopback client with a wrong token', async (path) => {
    const res = await fetch(`${base}${path}`, offLoopback({ authorization: 'Bearer not-the-token' }));
    expect(res.status).toBe(401);
  });

  it('rejects /api/redoc from a non-loopback client with a wrong query token', async () => {
    const res = await fetch(`${base}/api/redoc?token=not-the-token`, offLoopback());
    expect(res.status).toBe(401);
  });

  it.each(DOCS_PATHS)('serves %s to a non-loopback client bearing the token', async (path) => {
    const res = await fetch(`${base}${path}`, offLoopback({ authorization: `Bearer ${TOKEN}` }));
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeGreaterThan(0);
  });

  it.each(DOCS_PATHS)('serves %s to a loopback client with no token at all', async (path) => {
    delete process.env.LAB_API_TOKEN;
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(200);
  });

  it('serves the generated openapi document as json', async () => {
    const res = await fetch(`${base}/api/swagger-json`, offLoopback({ authorization: `Bearer ${TOKEN}` }));
    expect(res.headers.get('content-type')).toContain('application/json');
    const body: unknown = await res.json();
    expect(body).toMatchObject({
      openapi: '3.0.2',
      info: { title: 'Brokkr Local — Lab API' },
      paths: { '/api/services': { get: {} } },
    });
  });

  it('no longer publishes the retired getting-started route', async () => {
    const res = await fetch(`${base}/api/swagger-json`, offLoopback({ authorization: `Bearer ${TOKEN}` }));
    const body: unknown = await res.json();
    const paths = isRecord(body) && isRecord(body.paths) ? Object.keys(body.paths) : [];
    expect(paths).not.toContain('/api/docs/getting-started');
    expect(paths.length).toBeGreaterThan(0);
  });

  it('serves the spec json to a non-loopback client bearing the query token', async () => {
    const res = await fetch(`${base}/api/swagger-json?token=${TOKEN}`, offLoopback());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body: unknown = await res.json();
    expect(body).toMatchObject({ openapi: '3.0.2' });
  });

  it.each([
    ['/api/redoc', 'redoc'],
    ['/api/swagger', 'swagger-ui'],
  ])('serves %s as html referencing the spec url', async (path, marker) => {
    const res = await fetch(`${base}${path}`, offLoopback({ authorization: `Bearer ${TOKEN}` }));
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('/api/swagger-json');
    expect(html).toContain(marker);
  });

  it('threads the query token into the spec url for a non-loopback client', async () => {
    const res = await fetch(`${base}/api/swagger?token=${TOKEN}`, offLoopback());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`swagger-json?token=${TOKEN}`);
  });

  it('serves /api/swagger to a loopback client with the bare spec url', async () => {
    const res = await fetch(`${base}/api/swagger`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('/api/swagger-json');
    expect(html).not.toContain('swagger-json?token=');
  });

  it.each(['/api/redoc', '/api/swagger'])('applies the theme query param on %s', async (path) => {
    const auth = offLoopback({ authorization: `Bearer ${TOKEN}` });
    const fallback = await (await fetch(`${base}${path}`, auth)).text();
    const themed = await (await fetch(`${base}${path}?theme=solarized-light`, auth)).text();
    expect(themed).not.toBe(fallback);
  });

  it.each(DOCS_PATHS)('exposes no mutating verb on %s', async (path) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'x-forwarded-for': REMOTE } });
    expect(res.status).toBe(404);
  });
});
