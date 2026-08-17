import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, IncomingMessage, type IncomingHttpHeaders } from 'node:http';
import { connect, createServer as createNetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';

import { closeDb } from '../../db/db';
import { AuditStore } from '../../ledger/audit-store';
import { NULL_RUN_SINK } from '../../runner/run-sink';
import { RunnerService } from '../../runner/runner.service';
import { attachWebSockets } from '../shell-server';

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-ws-exposure-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
});

afterEach(() => {
  closeDb();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

const TERMINALS = ['/api/fleet/shell', '/api/tests/term?runId=missing'];

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
    client.once('data', (chunk: Buffer) => resolve(chunk.toString().split('\r\n')[0]));
    client.once('close', () => resolve('destroyed'));
    client.once('error', () => resolve('destroyed'));
    setTimeout(() => resolve('no outcome'), 2_000).unref();
  });
}

async function attemptUpgrade(path: string, peer: string, headers: IncomingHttpHeaders = {}): Promise<string> {
  const server = createHttpServer();
  attachWebSockets(server, new RunnerService(NULL_RUN_SINK), new AuditStore());
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

describe.each(TERMINALS)('ws upgrade exposure — %s', (path) => {
  it('upgrades a loopback peer', async () => {
    await expect(attemptUpgrade(path, '127.0.0.1')).resolves.toBe('HTTP/1.1 101 Switching Protocols');
  });

  it('destroys a non-loopback peer holding a valid token', async () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    vi.stubEnv('LAB_ALLOW_REMOTE_SHARP', undefined);

    await expect(attemptUpgrade(path, '10.0.0.5', { authorization: 'Bearer sekret-token' })).resolves.toBe('destroyed');
  });

  it('destroys a loopback peer whose forwarded chain carries a non-loopback hop', async () => {
    vi.stubEnv('LAB_ALLOW_REMOTE_SHARP', undefined);

    await expect(attemptUpgrade(path, '127.0.0.1', { 'x-forwarded-for': '10.0.0.5, 127.0.0.1' })).resolves.toBe(
      'destroyed',
    );
  });

  it('upgrades a non-loopback peer when LAB_ALLOW_REMOTE_SHARP is 1', async () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    vi.stubEnv('LAB_ALLOW_REMOTE_SHARP', '1');

    await expect(attemptUpgrade(path, '10.0.0.5', { authorization: 'Bearer sekret-token' })).resolves.toBe(
      'HTTP/1.1 101 Switching Protocols',
    );
  });
});
