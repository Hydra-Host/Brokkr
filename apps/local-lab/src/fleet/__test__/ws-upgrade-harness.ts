import { randomBytes } from 'node:crypto';
import { createServer as createHttpServer, IncomingMessage, type IncomingHttpHeaders } from 'node:http';
import { connect, createServer as createNetServer, type Socket } from 'node:net';

import type { AuditStore } from '../../ledger/audit-store';
import { NULL_RUN_SINK } from '../../runner/run-sink';
import { RunnerService } from '../../runner/runner.service';
import { attachWebSockets } from '../shell-server';

export function handshakeHeaders(): IncomingHttpHeaders {
  return {
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-version': '13',
    'sec-websocket-key': randomBytes(16).toString('base64'),
  };
}

export async function socketPair(): Promise<{ client: Socket; accepted: Socket; close: () => void }> {
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

export function firstOutcome(client: Socket): Promise<string> {
  return new Promise((resolve) => {
    client.once('data', (chunk: Buffer) => resolve(chunk.toString().split('\r\n')[0]!));
    client.once('close', () => resolve('destroyed'));
    client.once('error', () => resolve('destroyed'));
    setTimeout(() => resolve('no outcome'), 2_000).unref();
  });
}

export async function attemptUpgrade(
  store: AuditStore,
  path: string,
  peer: string,
  headers: IncomingHttpHeaders = {},
): Promise<string> {
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
