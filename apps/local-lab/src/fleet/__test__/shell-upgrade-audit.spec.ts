import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AuditEventRow, closeDb } from '../../db/db';
import { AuditStore } from '../../ledger/audit-store';
import { WS_TOKEN_PROTOCOL } from '@repo/local-lab-contract';

import { attemptUpgrade } from './ws-upgrade-harness';

let stateDir: string;
let store: AuditStore;

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

const upgrade = (path: string, peer: string, headers: IncomingHttpHeaders = {}) =>
  attemptUpgrade(store, path, peer, headers);

describe('ws upgrade audit on attach', () => {
  it('records the fleet console attach of a loopback peer', async () => {
    await expect(upgrade('/api/fleet/shell?node=cn1', '127.0.0.1')).resolves.toBe(
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
    await expect(upgrade('/api/tests/term?runId=missing', '127.0.0.1')).resolves.toBe(
      'HTTP/1.1 101 Switching Protocols',
    );

    expect(onlyRow()).toMatchObject({
      path: '/api/tests/term',
      handler: 'WebSocket.testTerm',
      outcome: 'ok',
    });
    expect(JSON.parse(onlyRow().params!)).toEqual({ runId: 'missing' });
  });

  it('redacts a token that reached the url anyway', async () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');

    await upgrade('/api/fleet/shell?node=cn1&token=sekret-token', '127.0.0.1');

    expect(JSON.parse(onlyRow().params!)).toEqual({ node: 'cn1', token: '***' });
    expect(onlyRow().params).not.toContain('sekret-token');
  });

  it('names the host principal that authorized a remote attach', async () => {
    vi.stubEnv('LAB_HOST_TOKEN', 'host-token');

    await upgrade('/api/fleet/shell?node=cn1', '10.0.0.5', {
      'sec-websocket-protocol': `${WS_TOKEN_PROTOCOL}, host-token`,
    });

    expect(onlyRow()).toMatchObject({
      outcome: 'ok',
      origin_ip: '10.0.0.5',
      origin_loopback: 0,
      origin_token: 1,
      origin_principal: 'host',
    });
  });
});

describe('ws upgrade audit on denial', () => {
  it('records a remote peer with no token', async () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');

    await expect(upgrade('/api/fleet/shell?node=cn1', '10.0.0.5')).resolves.toBe('destroyed');

    expect(onlyRow()).toMatchObject({
      method: 'WS',
      handler: 'WebSocket.fleetShell',
      outcome: 'denied',
      status_code: null,
      origin_ip: '10.0.0.5',
      origin_loopback: 0,
      origin_token: 0,
      origin_principal: null,
    });
    expect(onlyRow().error).toMatch(/host-exec/);
  });

  it('records an api-token remote peer denied for want of host-exec', async () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');

    await expect(
      upgrade('/api/tests/term?runId=missing', '10.0.0.5', {
        'sec-websocket-protocol': `${WS_TOKEN_PROTOCOL}, sekret-token`,
      }),
    ).resolves.toBe('destroyed');

    expect(onlyRow()).toMatchObject({
      outcome: 'denied',
      origin_token: 1,
      origin_principal: 'api',
      handler: 'WebSocket.testTerm',
    });
    expect(onlyRow().error).toMatch(/host-exec/);
  });

  it('records a peer that sent its token in the query string', async () => {
    vi.stubEnv('LAB_HOST_TOKEN', 'host-token');

    await expect(upgrade('/api/fleet/shell?node=cn1&token=host-token', '10.0.0.5')).resolves.toBe('destroyed');

    expect(onlyRow()).toMatchObject({ outcome: 'denied', handler: 'WebSocket.fleetShell' });
    expect(onlyRow().error).toMatch(/subprotocol/);
  });

  it('records a loopback peer whose forwarded chain carries a non-loopback hop', async () => {
    await expect(
      upgrade('/api/fleet/shell?node=cn1', '127.0.0.1', { 'x-forwarded-for': '10.0.0.5, 127.0.0.1' }),
    ).resolves.toBe('destroyed');

    expect(onlyRow()).toMatchObject({ outcome: 'denied', origin_ip: '127.0.0.1', origin_loopback: 1 });
  });

  it('records an upgrade to a path neither terminal serves', async () => {
    await expect(upgrade('/api/nope', '127.0.0.1')).resolves.toBe('destroyed');

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

    await expect(upgrade('/api/fleet/shell?node=cn1', '127.0.0.1')).resolves.toBe(
      'HTTP/1.1 101 Switching Protocols',
    );
  });

  it('still destroys a denied socket when the audit write throws', async () => {
    vi.stubEnv('LAB_API_TOKEN', 'sekret-token');
    vi.spyOn(store, 'insert').mockImplementation(() => {
      throw new Error('database is locked');
    });

    await expect(upgrade('/api/fleet/shell?node=cn1', '10.0.0.5')).resolves.toBe('destroyed');
  });
});
