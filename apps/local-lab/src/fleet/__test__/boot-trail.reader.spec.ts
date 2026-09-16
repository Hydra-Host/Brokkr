import { describe, expect, it } from 'vitest';

import { BootTrailReader, type TrailClient } from '../boot-trail.reader';

const MAC = 'aa:bb:cc:dd:ee:01';
const PXE_KEY = `z1:dhcp:pxe:${MAC}`;
const PENDING_KEY = `z1:discovery:pending:${MAC}`;
const CHAIN_KEY = `z1:ipxe:chain:${MAC}`;

interface Fake {
  pxeKeys?: string[];
  pendingKeys?: string[];
  chainKeys?: string[];
  hash?: Record<string, string>;
  chainValue?: string | null;
  scanError?: Error;
  seen?: string[];
}

function keysFor(fake: Fake, pattern: string): string[] {
  if (pattern.includes(':dhcp:pxe:')) return fake.pxeKeys ?? [];
  if (pattern.includes(':ipxe:chain:')) return fake.chainKeys ?? [];
  return fake.pendingKeys ?? [];
}

function fakeClient(fake: Fake): TrailClient {
  return {
    scan: (_cursor, _match, pattern) => {
      fake.seen?.push(pattern);
      if (fake.scanError) return Promise.reject(fake.scanError);
      return Promise.resolve(['0', keysFor(fake, pattern)]);
    },
    get: () => Promise.resolve(fake.chainValue ?? null),
    hgetall: () => Promise.resolve(fake.hash ?? {}),
  };
}

const reader = (client: TrailClient): BootTrailReader => new BootTrailReader({ client: () => client });

describe('BootTrailReader.read', () => {
  it('reports the recorded decision and whether the chain route was reached', async () => {
    const trail = await reader(
      fakeClient({ pxeKeys: [PXE_KEY], hash: { outcome: 'refused-allowlist', at: '1700' } }),
    ).read(MAC);

    expect(trail).toEqual({
      pxe: { outcome: 'refused-allowlist', atMs: 1700 },
      chainReached: false,
      chainAtMs: null,
      readError: null,
    });
  });

  it('reports no decision when the bridge holds no key for the mac', async () => {
    expect(await reader(fakeClient({})).read(MAC)).toEqual({
      pxe: null,
      chainReached: false,
      chainAtMs: null,
      readError: null,
    });
  });

  it('reports the chain as reached when a pending key exists', async () => {
    const trail = await reader(fakeClient({ pendingKeys: [PENDING_KEY] })).read(MAC);

    expect(trail.chainReached).toBe(true);
    expect(trail.chainAtMs).toBeNull();
    expect(trail.pxe).toBeNull();
  });

  it('reads the chain-hit time from the json string the bridge writes when no pending key exists', async () => {
    const trail = await reader(
      fakeClient({ chainKeys: [CHAIN_KEY], chainValue: JSON.stringify({ atMs: 1800, deviceId: 'dev-1' }) }),
    ).read(MAC);

    expect(trail).toEqual({ pxe: null, chainReached: true, chainAtMs: 1800, readError: null });
  });

  it('accepts a chain hit the bridge recorded before it matched the mac to a device', async () => {
    const trail = await reader(
      fakeClient({ chainKeys: [CHAIN_KEY], chainValue: JSON.stringify({ atMs: 1800, deviceId: null }) }),
    ).read(MAC);

    expect(trail.chainAtMs).toBe(1800);
  });

  it('reports the chain as reached without a time when the hit value is not the json the bridge writes', async () => {
    for (const chainValue of ['{"atMs":"soon","deviceId":null}', 'not json', '{"deviceId":"dev-1"}']) {
      const trail = await reader(fakeClient({ chainKeys: [CHAIN_KEY], chainValue })).read(MAC);

      expect(trail).toEqual({ pxe: null, chainReached: true, chainAtMs: null, readError: null });
    }
  });

  it('reports the chain as reached without a time when the hit key expired between scan and read', async () => {
    const trail = await reader(fakeClient({ chainKeys: [CHAIN_KEY], chainValue: null })).read(MAC);

    expect(trail).toEqual({ pxe: null, chainReached: true, chainAtMs: null, readError: null });
  });

  it('reports a failed scan as a read error with every field at its unknown default', async () => {
    const trail = await reader(fakeClient({ scanError: new Error('ECONNREFUSED') })).read(MAC);

    expect(trail.readError).toContain('ECONNREFUSED');
    expect(trail).toMatchObject({ pxe: null, chainReached: null, chainAtMs: null });
  });

  it('reports no decision rather than throwing when the hash does not parse', async () => {
    const trail = await reader(fakeClient({ pxeKeys: [PXE_KEY], hash: { outcome: 'bogus', at: 'soon' } })).read(MAC);

    expect(trail).toEqual({ pxe: null, chainReached: false, chainAtMs: null, readError: null });
  });

  it('scans under the lowercase colon-separated mac the bridge keys by', async () => {
    const seen: string[] = [];
    await reader(fakeClient({ seen })).read('AA-BB-CC-DD-EE-01');

    expect(seen.sort()).toEqual([`*:dhcp:pxe:${MAC}`, `*:discovery:pending:${MAC}`, `*:ipxe:chain:${MAC}`]);
  });

  it('follows the scan cursor rather than trusting one page', async () => {
    const pages = new Map<string, [string, string[]]>([
      ['0', ['7', []]],
      ['7', ['0', [PXE_KEY]]],
    ]);
    const client: TrailClient = {
      scan: (cursor, _match, pattern) =>
        Promise.resolve(pattern.includes(':dhcp:pxe:') ? (pages.get(cursor) ?? ['0', []]) : ['0', []]),
      get: () => Promise.resolve(null),
      hgetall: () => Promise.resolve({ outcome: 'offered', at: '1700' }),
    };

    expect((await reader(client).read(MAC)).pxe).toEqual({ outcome: 'offered', atMs: 1700 });
  });
});
