import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, IncomingMessage, type IncomingHttpHeaders } from 'node:http';
import { connect, createServer as createNetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AuditEventRow, closeDb } from '../../db/db';
import { AuditStore } from '../../ledger/audit-store';
import { NULL_RUN_SINK } from '../../runner/run-sink';
import { RunnerService } from '../../runner/runner.service';
import { attachWebSockets } from '../shell-server';

let stateDir: string;
let store: AuditStore;

function handshakeHeaders(): IncomingHttpHeaders {
  return {
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-version': '13',
    'sec-websocket-key': randomBytes(16).toString('base64'),
  };
}

async function socketPair(): Promise<{ client: Socket; accepted: Socket; close: () => void }> {
  const listener = createNetServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (address === null || typeof address === 'string') throw new Error('no tcp address');
  const incoming = new Promise<Socket>((resolve) => listener.once('connection', resolve));
  const client = connect(address.port, '127.0.0.1');
  await new Promise<void>((resolve) => client.once('connect', () => resolve()));
  const accepted = await incoming;
  listener.close();
  return {
    client,
    accepted,
    close: () => {
      client.destroy();
      accepted.destroy();
    },
  };
}

function firstOutcome(client: Socket): Promise<string> {
  return new Promise((resolve) => {
    client.once('data', (chunk: Buffer) => resolve(chunk.toString().split('\r\n')[0]!));
    client.once('close', () => resolve('destroyed'));
    client.once('error', () => resolve('destroyed'));
    setTimeout(() => resolve('no outcome'), 2_000).unref();
  });
}

async function attemptUpgrade(path: string, peer: string, headers: IncomingHttpHeaders = {}): Promise<string> {
  const server = createHttpServer();
  attachWebSockets(server, new RunnerService(NULL_RUN_SINK), store);
  const { client, accepted, close } = await socketPair();
  Object.defineProperty(accepted, 'remoteAddress', { value: peer, configurable: true });
  const req = new IncomingMessage(accepted);
  req.method = 'GET';
  req.url = path;
  req.headers = { ...handshakeHeaders(), ...headers };
  const settled = firstOutcome(client);
  server.emit('upgrade', req, accepted, Buffer.alloc(0));
  const outcome = await settled;
  close();
  return outcome;
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
  stateDir = mkdtempSync(join(tmpdir(), 'lab-ws-audit-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
  store = new AuditStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

describe('ws upgrade audit on attach', () => {
  it('records the fleet console attach of a loopback peer', async () => {
    await expect(attemptUpgrade('/api/fleet/shell?node=cn1', '127.0.0.1')).resolves.toBe(
      'HTTP/1.1 101 Switching Protocols',
    );

    expect(onlyRow()).toMatchObject({
      method: 'WS',
      path: '/api/fleet/shell',
      handler: 'WebSocket.fleetShell',
      outcome: 'ok',
      status_code: null,
      duration_ms: null,
      run_id: null,
      origin_ip: '127.0.0.1',
      origin_loopback: 1,
      origin_token: 0,
      error: null,
    });
    expect(JSON.parse(onlyRow().params!)).toEqual({ node: 'cn1' });
  });

  it('records the test terminal under its own handler name', async () => {
    await expect(attemptUpgrade('/api/tests/term?runId=missing', '127.0.0.1')).resolves.toBe(
      'HTTP/1.1 101 Switching Protocols',
    );

    expect(onlyRow()).toMatchObject({
      path: '/api/tests/term',
      handler: 'WebSocket.testTerm',
      outcome: 'ok',
    });
    expect(JSON.parse(onlyRow().params!)).toEqual({ runId: 'missing' });
  });

  it('redacts the token the web app appends to the stream url', async () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');

    await attemptUpgrade('/api/fleet/shell?node=cn1&token=sekret-token', '127.0.0.1');

    expect(JSON.parse(onlyRow().params!)).toEqual({ node: 'cn1', token: '***' });
    expect(onlyRow().params).not.toContain('sekret-token');
  });

  it('records that a valid token was presented alongside the loopback verdict', async () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    vi.stubEnv('LAB_ALLOW_REMOTE_SHARP', '1');

    await attemptUpgrade('/api/fleet/shell?node=cn1', '10.0.0.5', { authorization: 'Bearer sekret-token' });

    expect(onlyRow()).toMatchObject({
      outcome: 'ok',
      origin_ip: '10.0.0.5',
      origin_loopback: 0,
      origin_token: 1,
    });
  });
});

describe('ws upgrade audit on denial', () => {
  it('records a remote peer with no token', async () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');

    await expect(attemptUpgrade('/api/fleet/shell?node=cn1', '10.0.0.5')).resolves.toBe('destroyed');

    expect(onlyRow()).toMatchObject({
      method: 'WS',
      handler: 'WebSocket.fleetShell',
      outcome: 'denied',
      status_code: null,
      origin_ip: '10.0.0.5',
      origin_loopback: 0,
      origin_token: 0,
    });
    expect(onlyRow().error).toMatch(/LAB_API_TOKEN/);
  });

  it('records a token-bearing remote peer denied by the loopback-only rule', async () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    vi.stubEnv('LAB_ALLOW_REMOTE_SHARP', undefined);

    await expect(
      attemptUpgrade('/api/tests/term?runId=missing', '10.0.0.5', { authorization: 'Bearer sekret-token' }),
    ).resolves.toBe('destroyed');

    expect(onlyRow()).toMatchObject({ outcome: 'denied', origin_token: 1, handler: 'WebSocket.testTerm' });
    expect(onlyRow().error).toMatch(/loopback-only/);
  });

  it('records a loopback peer whose forwarded chain carries a non-loopback hop', async () => {
    await expect(
      attemptUpgrade('/api/fleet/shell?node=cn1', '127.0.0.1', { 'x-forwarded-for': '10.0.0.5, 127.0.0.1' }),
    ).resolves.toBe('destroyed');

    expect(onlyRow()).toMatchObject({ outcome: 'denied', origin_ip: '127.0.0.1', origin_loopback: 1 });
  });

  it('records an upgrade to a path neither terminal serves', async () => {
    await expect(attemptUpgrade('/api/nope', '127.0.0.1')).resolves.toBe('destroyed');

    expect(onlyRow()).toMatchObject({
      method: 'WS',
      path: '/api/nope',
      handler: 'WebSocket.unknown',
      outcome: 'denied',
    });
    expect(onlyRow().error).toMatch(/unknown upgrade path/);
  });
});

describe('ws upgrade audit write failure', () => {
  it('still upgrades a loopback peer when the audit write throws', async () => {
    vi.spyOn(store, 'insert').mockImplementation(() => {
      throw new Error('database is locked');
    });

    await expect(attemptUpgrade('/api/fleet/shell?node=cn1', '127.0.0.1')).resolves.toBe(
      'HTTP/1.1 101 Switching Protocols',
    );
  });

  it('still destroys a denied socket when the audit write throws', async () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    vi.spyOn(store, 'insert').mockImplementation(() => {
      throw new Error('database is locked');
    });

    await expect(attemptUpgrade('/api/fleet/shell?node=cn1', '10.0.0.5')).resolves.toBe('destroyed');
  });
});
