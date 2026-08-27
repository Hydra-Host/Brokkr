import { Logger } from '@nestjs/common';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import http from 'node:http';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';

import { type AuditEventRow, closeDb } from '../../db/db';
import { AuditStore } from '../../ledger/audit-store';
import { PORTS } from '../../ports';
import { isMutationOriginAllowed } from '../lab-auth';
import { labOriginMiddleware } from '../lab-context';
import { requireJsonMutation } from '../require-json-mutation.middleware';

const ORIG = { ...process.env };
const ALLOWED_ORIGIN = 'http://localhost:5175';
const LAB_PORT = String(PORTS.lab);
const WEB_PORT = '5175';
const LAN_IP = '192.168.1.50';
const LAN_HOSTNAME = 'mymac.local';

let server: Server;
let port = 0;
let stateDir: string;
const store = new AuditStore();

function send(
  method: string,
  headers: http.OutgoingHttpHeaders,
  body?: string,
  path = '/api/stack/runs',
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const opts = { host: '127.0.0.1', port, path, method, headers, agent: false };
    const req = http.request(opts, (res) => {
      res.setEncoding('utf8');
      let text = '';
      res.on('data', (chunk: string) => {
        text += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function auditRows(): AuditEventRow[] {
  return store.list({ limit: 50, offset: 0 }).rows;
}

beforeAll(async () => {
  const app = express();
  app.use(labOriginMiddleware);
  app.use(requireJsonMutation(store));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.all('/api/stack/runs', (req, res) => {
    res.status(200).json({ received: req.body });
  });
  server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const addr = server.address();
  port = typeof addr === 'object' && addr !== null ? addr.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-mutation-guard-'));
  process.env.LOCAL_STATE = stateDir;
  process.env.LAB_CORS_ORIGINS = ALLOWED_ORIGIN;
  process.env.LAB_WEB_PORT = WEB_PORT;
});

afterEach(() => {
  process.env = { ...ORIG };
  vi.restoreAllMocks();
  closeDb();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('requireJsonMutation', () => {
  it('rejects a form-encoded post with 415 (the drive-by csrf vector)', async () => {
    const res = await send(
      'POST',
      { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example.com' },
      'opId=fleet-reset',
    );
    expect(res.status).toBe(415);
    expect(JSON.parse(res.text)).toEqual({ error: 'mutating requests must use content-type: application/json' });
  });

  it('allows a json post and still parses its body', async () => {
    const res = await send('POST', { 'content-type': 'application/json' }, JSON.stringify({ opId: 'fleet-reset' }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toEqual({ received: { opId: 'fleet-reset' } });
  });

  it('rejects every other content type a form or opaque client can send', async () => {
    for (const contentType of [
      'multipart/form-data; boundary=x',
      'text/plain',
      'text/plain;charset=UTF-8',
      'application/octet-stream',
    ]) {
      const res = await send('POST', { 'content-type': contentType }, 'opId=fleet-reset');
      expect(res.status).toBe(415);
    }
  });

  it('accepts application/json with parameters and odd casing', async () => {
    for (const contentType of ['application/json; charset=utf-8', 'Application/JSON', ' application/json ']) {
      const res = await send('POST', { 'content-type': contentType }, '{}');
      expect(res.status).toBe(200);
    }
  });

  it('allows a bodyless post that declares no content type (curl / cli)', async () => {
    const res = await send('POST', {});
    expect(res.status).toBe(200);
  });

  it('rejects a present-but-disallowed origin with 403 even when the content type is json', async () => {
    const res = await send(
      'POST',
      { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      JSON.stringify({ opId: 'fleet-reset' }),
    );
    expect(res.status).toBe(403);
    expect(JSON.parse(res.text)).toEqual({
      error: 'origin is not allowed to make mutating requests against the lab control API',
    });
  });

  it('rejects the opaque null origin of a sandboxed frame', async () => {
    const res = await send('POST', { 'content-type': 'application/json', origin: 'null' }, '{}');
    expect(res.status).toBe(403);
  });

  it('allows an allowlisted origin', async () => {
    const res = await send('POST', { 'content-type': 'application/json', origin: ALLOWED_ORIGIN }, '{}');
    expect(res.status).toBe(200);
  });

  it('reads the allowlist per request so a LAB_CORS_ORIGINS override takes effect', async () => {
    process.env.LAB_CORS_ORIGINS = 'https://first.example.com';
    expect(
      (await send('POST', { 'content-type': 'application/json', origin: 'https://first.example.com' }, '{}')).status,
    ).toBe(200);
    process.env.LAB_CORS_ORIGINS = 'https://second.example.com';
    expect(
      (await send('POST', { 'content-type': 'application/json', origin: 'https://first.example.com' }, '{}')).status,
    ).toBe(403);
    expect(
      (await send('POST', { 'content-type': 'application/json', origin: 'https://second.example.com' }, '{}')).status,
    ).toBe(200);
  });

  it('allows a loopback origin on either lab port with no allowlist entry (the dev and vite-proxy case)', async () => {
    process.env.LAB_CORS_ORIGINS = 'https://ops.example.com';
    for (const origin of [
      `http://localhost:${WEB_PORT}`,
      `http://127.0.0.1:${WEB_PORT}`,
      `http://[::1]:${WEB_PORT}`,
      `http://localhost:${LAB_PORT}`,
      `http://127.0.0.1:${LAB_PORT}`,
      `http://[::1]:${LAB_PORT}`,
    ]) {
      const res = await send(
        'POST',
        { 'content-type': 'application/json', host: `127.0.0.1:${LAB_PORT}`, origin },
        '{}',
      );
      expect(res.status).toBe(200);
    }
  });

  it('denies a lan origin when the connection itself arrived on loopback (the forged host proves nothing)', async () => {
    const res = await send(
      'POST',
      { 'content-type': 'application/json', host: `${LAN_IP}:${LAB_PORT}`, origin: `http://${LAN_IP}:${WEB_PORT}` },
      '{}',
    );
    expect(res.status).toBe(403);
  });

  it('denies a hostname origin from an untokened caller (a dns name proves nothing about the socket)', async () => {
    const res = await send(
      'POST',
      {
        'content-type': 'application/json',
        host: `${LAN_HOSTNAME}:${LAB_PORT}`,
        origin: `http://${LAN_HOSTNAME}:${WEB_PORT}`,
      },
      '{}',
    );
    expect(res.status).toBe(403);
  });

  it('lets a token-authenticated caller mutate from any origin: the token is the anti-csrf proof', async () => {
    process.env.LAB_API_TOKEN = 'sekret-token';
    for (const origin of [
      `http://${LAN_HOSTNAME}:${WEB_PORT}`,
      `http://lab-box:${WEB_PORT}`,
      'https://ops.example.com',
    ]) {
      const res = await send(
        'POST',
        { 'content-type': 'application/json', origin, 'x-lab-token': 'sekret-token' },
        '{}',
      );
      expect(res.status).toBe(200);
    }
  });

  it('denies an unallowlisted origin whose token is absent, wrong, or unconfigured', async () => {
    process.env.LAB_API_TOKEN = 'sekret-token';
    const origin = `http://${LAN_HOSTNAME}:${WEB_PORT}`;
    for (const extra of [{}, { 'x-lab-token': 'wrong-token!' }]) {
      const res = await send('POST', { 'content-type': 'application/json', origin, ...extra }, '{}');
      expect(res.status).toBe(403);
    }
    delete process.env.LAB_API_TOKEN;
    const res = await send('POST', { 'content-type': 'application/json', origin, 'x-lab-token': 'sekret-token' }, '{}');
    expect(res.status).toBe(403);
  });

  it('allows the request own loopback origin (prod-served spa and swagger try it out)', async () => {
    for (const origin of [`http://127.0.0.1:${LAB_PORT}`, `http://localhost:${LAB_PORT}`]) {
      const res = await send('POST', { 'content-type': 'application/json', origin }, '{}');
      expect(res.status).toBe(200);
    }
  });

  it('denies a dns-rebinding page whose origin agrees with the host header (both are caller-supplied)', async () => {
    const res = await send(
      'POST',
      { 'content-type': 'application/json', host: `evil.com:${LAB_PORT}`, origin: `http://evil.com:${WEB_PORT}` },
      '{}',
    );
    expect(res.status).toBe(403);
  });

  it('denies a rebinding origin even when the host header matches it exactly', async () => {
    const res = await send(
      'POST',
      { 'content-type': 'application/json', host: `evil.com:${WEB_PORT}`, origin: `http://evil.com:${WEB_PORT}` },
      '{}',
    );
    expect(res.status).toBe(403);
  });

  it('ignores x-forwarded-host even behind a trusted proxy (the forwarded host is caller-supplied too)', async () => {
    process.env.LAB_TRUST_PROXY = '1';
    const res = await send(
      'POST',
      {
        'content-type': 'application/json',
        host: `127.0.0.1:${LAB_PORT}`,
        'x-forwarded-host': `evil.com:${WEB_PORT}`,
        origin: `http://evil.com:${WEB_PORT}`,
      },
      '{}',
    );
    expect(res.status).toBe(403);
  });

  it('rejects a foreign origin however the request host is addressed', async () => {
    for (const host of [`${LAN_IP}:${LAB_PORT}`, `${LAN_HOSTNAME}:${LAB_PORT}`, `127.0.0.1:${LAB_PORT}`]) {
      const res = await send('POST', { 'content-type': 'application/json', host, origin: 'https://evil.com' }, '{}');
      expect(res.status).toBe(403);
      expect(JSON.parse(res.text)).toEqual({
        error: 'origin is not allowed to make mutating requests against the lab control API',
      });
    }
  });

  it('rejects a foreign origin that borrows a lab port or dresses up as the request host', async () => {
    const cases: [string, string][] = [
      [`${LAN_IP}:${LAB_PORT}`, `http://evil.com:${WEB_PORT}`],
      [`${LAN_IP}:${LAB_PORT}`, `http://evil.com:${LAB_PORT}`],
      [`${LAN_IP}:${LAB_PORT}`, `http://${LAN_IP}.evil.com:${WEB_PORT}`],
      [`${LAN_HOSTNAME}:${LAB_PORT}`, `http://${LAN_HOSTNAME}.evil.com:${WEB_PORT}`],
      [`${LAN_HOSTNAME}:${LAB_PORT}`, `http://evil.${LAN_HOSTNAME}:${WEB_PORT}`],
      [`${LAN_HOSTNAME}:${LAB_PORT}`, `http://not${LAN_HOSTNAME}:${WEB_PORT}`],
    ];
    for (const [host, origin] of cases) {
      const res = await send('POST', { 'content-type': 'application/json', host, origin }, '{}');
      expect(res.status).toBe(403);
    }
  });

  it('rejects even a loopback or lan origin on a port that is neither lab port', async () => {
    for (const origin of ['http://127.0.0.1:9999', `http://${LAN_IP}:9999`]) {
      const res = await send(
        'POST',
        { 'content-type': 'application/json', host: `127.0.0.1:${LAB_PORT}`, origin },
        '{}',
      );
      expect(res.status).toBe(403);
    }
  });

  it('guards put, patch and delete alongside post', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect((await send(method, { 'content-type': 'text/plain' }, 'x')).status).toBe(415);
      expect(
        (await send(method, { 'content-type': 'application/json', origin: 'https://evil.example.com' }, '{}')).status,
      ).toBe(403);
      expect((await send(method, { 'content-type': 'application/json' }, '{}')).status).toBe(200);
    }
  });

  it('leaves non-mutating methods untouched', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const res = await send(method, { 'content-type': 'text/plain', origin: 'https://evil.example.com' });
      expect(res.status).toBe(200);
    }
  });
});

describe('isMutationOriginAllowed', () => {
  it('allows a lan origin that names the address the connection arrived on', () => {
    expect(isMutationOriginAllowed(`http://${LAN_IP}:${WEB_PORT}`, LAN_IP)).toBe(true);
    expect(isMutationOriginAllowed(`http://${LAN_IP}:${LAB_PORT}`, LAN_IP)).toBe(true);
  });

  it('denies a lan origin naming any other arrival address', () => {
    expect(isMutationOriginAllowed(`http://${LAN_IP}:${WEB_PORT}`, '192.168.1.51')).toBe(false);
    expect(isMutationOriginAllowed(`http://${LAN_IP}:${WEB_PORT}`, '127.0.0.1')).toBe(false);
    expect(isMutationOriginAllowed(`http://${LAN_IP}:${WEB_PORT}`, undefined)).toBe(false);
  });

  it('denies a lan origin on a non-lab port even on the arrival address', () => {
    expect(isMutationOriginAllowed(`http://${LAN_IP}:9999`, LAN_IP)).toBe(false);
  });

  it('matches an ipv6 arrival address against a bracketed origin host', () => {
    expect(isMutationOriginAllowed(`http://[fd00::5]:${WEB_PORT}`, 'fd00::5')).toBe(true);
  });

  it('denies a hostname origin even when it resolves to the arrival address', () => {
    expect(isMutationOriginAllowed(`http://${LAN_HOSTNAME}:${WEB_PORT}`, LAN_IP)).toBe(false);
  });

  it('never consults this host own name: a lan client reaches us by a name we may not know', () => {
    process.env.LAB_BIND_HOST = '0.0.0.0';
    const own = hostname();
    expect(isMutationOriginAllowed(`http://${own}:${WEB_PORT}`, LAN_IP)).toBe(false);
    expect(isMutationOriginAllowed(`http://${own.split('.')[0]}:${WEB_PORT}`, LAN_IP)).toBe(false);
  });
});

describe('denial auditing', () => {
  it('records exactly one denied row for a 415', async () => {
    await send('POST', { 'content-type': 'text/plain' }, 'x');
    const all = auditRows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      method: 'POST',
      path: '/api/stack/runs',
      handler: 'requireJsonMutation',
      outcome: 'denied',
      status_code: 415,
      duration_ms: null,
      run_id: null,
      origin_ip: '127.0.0.1',
      origin_loopback: 1,
      origin_token: 0,
      error: 'mutating requests must use content-type: application/json',
    });
  });

  it('records exactly one denied row for a 403', async () => {
    await send('POST', { 'content-type': 'application/json', origin: 'https://evil.example.com' }, '{}');
    const all = auditRows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      method: 'POST',
      path: '/api/stack/runs',
      handler: 'requireJsonMutation',
      outcome: 'denied',
      status_code: 403,
      duration_ms: null,
      run_id: null,
      origin_ip: '127.0.0.1',
      origin_loopback: 1,
      origin_token: 0,
      error: 'origin is not allowed to make mutating requests against the lab control API',
    });
  });

  it('records the redacted query of a denied request (the body is not parsed yet)', async () => {
    await send('POST', { 'content-type': 'text/plain' }, 'opId=fleet-reset', '/api/stack/runs?token=guessed-token');
    expect(JSON.parse(auditRows()[0]!.params!)).toEqual({ token: '***' });
  });

  it('writes nothing for an allowed request', async () => {
    await send('POST', { 'content-type': 'application/json' }, '{}');
    expect(auditRows()).toEqual([]);
  });

  it('still answers the denial when the audit write throws, and warns', async () => {
    vi.spyOn(store, 'insert').mockImplementation(() => {
      throw new Error('database is locked');
    });
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const res = await send('POST', { 'content-type': 'text/plain' }, 'x');
    expect(res.status).toBe(415);
    expect(warn).toHaveBeenCalledOnce();
  });
});
