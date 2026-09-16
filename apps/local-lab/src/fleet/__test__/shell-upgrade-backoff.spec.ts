import { WS_TOKEN_PROTOCOL } from '@repo/local-lab-contract';
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AuditEventRow, closeDb } from '../../db/db';
import { AuditStore } from '../../ledger/audit-store';
import { attemptUpgrade } from './ws-upgrade-harness';

let stateDir: string;
let store: AuditStore;
let peerSeed = 0;
let PEER = '';
let OTHER_PEER = '';

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-ws-backoff-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
  vi.stubEnv('LAB_HOST_TOKEN', 'real-host-token');
  store = new AuditStore();
  peerSeed += 1;
  PEER = `10.1.${peerSeed}.5`;
  OTHER_PEER = `10.1.${peerSeed}.9`;
});

afterEach(() => {
  closeDb();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

const withToken = (token: string) => ({ 'sec-websocket-protocol': `${WS_TOKEN_PROTOCOL}, ${token}` });

const upgradeAs = (peer: string, headers: IncomingHttpHeaders = {}) =>
  attemptUpgrade(store, '/api/fleet/shell', peer, headers);

function lastError(): string | null {
  const all: AuditEventRow[] = store.list({ limit: 50, offset: 0 }).rows;
  return all[0]?.error ?? null;
}

async function guessTimes(n: number, peer = PEER): Promise<void> {
  for (let i = 0; i < n; i++) await upgradeAs(peer, withToken(`wrong-${i}`));
}

describe('ws upgrade backoff', () => {
  it('throttles an address after five rejected tokens', async () => {
    await guessTimes(5);
    expect(lastError()).toContain('host-exec');

    await expect(upgradeAs(PEER, withToken('wrong-again'))).resolves.toBe('destroyed');
    expect(lastError()).toContain('too many rejected lab tokens');
  });

  it('throttles the valid token too, so a guesser cannot be waited out by the real operator', async () => {
    await guessTimes(5);
    await expect(upgradeAs(PEER, withToken('real-host-token'))).resolves.toBe('destroyed');
    expect(lastError()).toContain('too many rejected lab tokens');
  });

  it('keeps the budget per address, so one guesser cannot lock everyone out', async () => {
    await guessTimes(5);
    await expect(upgradeAs(OTHER_PEER, withToken('real-host-token'))).resolves.toBe(
      'HTTP/1.1 101 Switching Protocols',
    );
  });

  it('does not count an absent token as a guess', async () => {
    for (let i = 0; i < 5; i++) await upgradeAs(PEER);
    await upgradeAs(PEER, withToken('wrong'));
    expect(lastError()).toContain('host-exec');
  });

  it('does not count a token that is merely below the ceiling as a guess', async () => {
    vi.stubEnv('LAB_API_TOKEN', 'api-only-token');
    for (let i = 0; i < 6; i++) await upgradeAs(PEER, withToken('api-only-token'));
    expect(lastError()).toContain('host-exec');
  });

  it('throttles across sockets, not per connection, so reconnecting buys no fresh allowance', async () => {
    await guessTimes(5);
    await expect(upgradeAs(PEER, withToken('real-host-token'))).resolves.toBe('destroyed');
    expect(lastError()).toContain('too many rejected lab tokens');
  });

  it('keeps counting guesses across a valid token upgrade from the same peer', async () => {
    await guessTimes(4);
    await expect(upgradeAs(PEER, withToken('real-host-token'))).resolves.toBe(
      'HTTP/1.1 101 Switching Protocols',
    );

    await guessTimes(1);

    await expect(upgradeAs(PEER, withToken('real-host-token'))).resolves.toBe('destroyed');
    expect(lastError()).toContain('too many rejected lab tokens');
  });
});
