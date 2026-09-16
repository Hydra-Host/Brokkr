import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';

import { closeDb } from '../../db/db';
import { AuditStore } from '../../ledger/audit-store';
import { WS_TOKEN_PROTOCOL } from '@repo/local-lab-contract';

import { attemptUpgrade } from './ws-upgrade-harness';

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

const upgrade = (path: string, peer: string, headers: IncomingHttpHeaders = {}) =>
  attemptUpgrade(new AuditStore(), path, peer, headers);

describe.each(TERMINALS)('ws upgrade capability — %s', (path) => {
  it('upgrades a loopback peer', async () => {
    await expect(upgrade(path, '127.0.0.1')).resolves.toBe('HTTP/1.1 101 Switching Protocols');
  });

  it('destroys a non-loopback peer holding the api token', async () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');

    await expect(
      upgrade(path, '10.0.0.5', { 'sec-websocket-protocol': `${WS_TOKEN_PROTOCOL}, sekret-token` }),
    ).resolves.toBe('destroyed');
  });

  it('destroys a loopback peer whose forwarded chain carries a non-loopback hop', async () => {
    await expect(upgrade(path, '127.0.0.1', { 'x-forwarded-for': '10.0.0.5, 127.0.0.1' })).resolves.toBe(
      'destroyed',
    );
  });

  it('destroys a loopback peer in fronted mode', async () => {
    vi.stubEnv('LAB_MODE', 'fronted');

    await expect(upgrade(path, '127.0.0.1')).resolves.toBe('destroyed');
  });

  it('upgrades a non-loopback peer presenting the host token as a subprotocol', async () => {
    vi.stubEnv('LAB_HOST_TOKEN', 'host-token');

    await expect(
      upgrade(path, '10.0.0.5', { 'sec-websocket-protocol': `${WS_TOKEN_PROTOCOL}, host-token` }),
    ).resolves.toBe('HTTP/1.1 101 Switching Protocols');
  });

  it('destroys a peer that puts the host token in the query string', async () => {
    vi.stubEnv('LAB_HOST_TOKEN', 'host-token');
    const separator = path.includes('?') ? '&' : '?';

    await expect(upgrade(`${path}${separator}token=host-token`, '10.0.0.5')).resolves.toBe('destroyed');
  });

  it('destroys a loopback peer that puts a token in the query string, whatever its value', async () => {
    await expect(upgrade(`${path}${path.includes('?') ? '&' : '?'}token=anything`, '127.0.0.1')).resolves.toBe(
      'destroyed',
    );
  });

  it('ignores an authorization header, which no browser WebSocket can send', async () => {
    vi.stubEnv('LAB_HOST_TOKEN', 'host-token');

    await expect(upgrade(path, '10.0.0.5', { authorization: 'Bearer host-token' })).resolves.toBe('destroyed');
  });
});
