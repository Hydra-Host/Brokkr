import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, vi } from 'vitest';

import { currentOrigin, type LabOrigin, labOriginMiddleware, type OriginRequest } from '../lab-context';

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(over: Partial<OriginRequest> = {}): OriginRequest {
  return { method: 'GET', path: '/api/ping', query: {}, socket: {}, headers: {}, ...over };
}

function originOf(over: Partial<OriginRequest> = {}): LabOrigin {
  let captured: LabOrigin | undefined;
  labOriginMiddleware(request(over), undefined, () => {
    captured = currentOrigin();
  });
  if (!captured) throw new Error('no origin captured');
  return captured;
}

describe('currentOrigin', () => {
  it('is undefined outside a request and populated inside the middleware', () => {
    expect(currentOrigin()).toBeUndefined();

    let inside: LabOrigin | undefined;
    labOriginMiddleware(
      request({ method: 'POST', path: '/api/stack/ops', socket: { remoteAddress: '127.0.0.1' } }),
      undefined,
      () => {
        inside = currentOrigin();
      },
    );

    expect(inside).toEqual({
      ip: '127.0.0.1',
      loopback: true,
      tokenAuth: false,
      method: 'POST',
      path: '/api/stack/ops',
    });
    expect(currentOrigin()).toBeUndefined();
  });
});

describe('tokenAuth', () => {
  it('records a valid token even when the request is loopback-authorized', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    const origin = originOf({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { authorization: 'Bearer sekret-token' },
    });

    expect(origin.loopback).toBe(true);
    expect(origin.tokenAuth).toBe(true);
  });

  it('reads the x-lab-token header and the query token, and stays false for a wrong token', () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');

    expect(originOf({ headers: { 'x-lab-token': 'sekret-token' } }).tokenAuth).toBe(true);
    expect(originOf({ query: { token: 'sekret-token' } }).tokenAuth).toBe(true);
    expect(originOf({ query: { token: 'nope' } }).tokenAuth).toBe(false);
    expect(originOf({ query: {} }).tokenAuth).toBe(false);
  });

  it('stays false when no token is configured', () => {
    vi.stubEnv('LAB_API_TOKEN', undefined);
    expect(originOf({ headers: { authorization: 'Bearer anything' } }).tokenAuth).toBe(false);
  });
});

describe('loopback classification', () => {
  it('treats ipv4-mapped ipv6 loopback as loopback and keeps the address verbatim', () => {
    const origin = originOf({ socket: { remoteAddress: '::ffff:127.0.0.1' } });

    expect(origin.ip).toBe('::ffff:127.0.0.1');
    expect(origin.loopback).toBe(true);
    expect(originOf({ socket: { remoteAddress: '::1' } }).loopback).toBe(true);
    expect(originOf({ socket: { remoteAddress: '::ffff:10.0.0.5' } }).loopback).toBe(false);
  });

  it('records a null ip when the peer address is unknown', () => {
    const origin = originOf({ socket: {} });

    expect(origin.ip).toBeNull();
    expect(origin.loopback).toBe(false);
  });

  it('prefers req.ip over the raw socket peer', () => {
    expect(originOf({ ip: '10.0.0.5', socket: { remoteAddress: '127.0.0.1' } }).ip).toBe('10.0.0.5');
  });
});

describe('LAB_TRUST_PROXY', () => {
  it('resolves the forwarded client only for a loopback peer', () => {
    vi.stubEnv('LAB_TRUST_PROXY', '1');
    const forwarded = originOf({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'x-forwarded-for': '10.0.0.5' },
    });

    expect(forwarded.ip).toBe('10.0.0.5');
    expect(forwarded.loopback).toBe(false);

    const remotePeer = originOf({
      socket: { remoteAddress: '10.0.0.9' },
      headers: { 'x-forwarded-for': '127.0.0.1' },
    });

    expect(remotePeer.ip).toBe('10.0.0.9');
    expect(remotePeer.loopback).toBe(false);
  });

  it('ignores the forwarded header entirely when trust is not enabled', () => {
    vi.stubEnv('LAB_TRUST_PROXY', undefined);
    const origin = originOf({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'x-forwarded-for': '10.0.0.5' },
    });

    expect(origin.ip).toBe('127.0.0.1');
    expect(origin.loopback).toBe(true);
  });
});

describe('over a real express request', () => {
  it('records the path without the query string and never stores the token secret', async () => {
    vi.stubEnv('LAB_API_TOKEN', 'hunter2');
    let captured: LabOrigin | undefined;
    const app = express();
    app.use(labOriginMiddleware);
    app.get('/x', (_req, res) => {
      captured = currentOrigin();
      res.end('ok');
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no tcp address');
    const port: AddressInfo['port'] = address.port;

    await fetch(`http://127.0.0.1:${port}/x?token=hunter2`).then((r) => r.text());
    await new Promise((resolve) => server.close(resolve));

    expect(captured?.path).toBe('/x');
    expect(captured?.method).toBe('GET');
    expect(captured?.tokenAuth).toBe(true);
    expect(captured?.loopback).toBe(true);
    expect(JSON.stringify(captured)).not.toContain('hunter2');
  });
});
