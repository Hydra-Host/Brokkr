import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { StackRegistryClient } from '../stack-registry-client';

const DEAD_PID = 4_000_000;

const createdDirs: string[] = [];
function newTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'stack-registry-'));
  createdDirs.push(dir);
  return dir;
}

function registryDir(root: string): string {
  const dir = join(root, 'brokkr-local', 'stacks');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeEntry(dir: string, slot: number, entry: Record<string, unknown>): void {
  writeFileSync(join(dir, `stack-${slot}.json`), JSON.stringify({ slot, ...entry }));
}

afterEach(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
  createdDirs.length = 0;
  delete process.env.XDG_STATE_HOME;
});

describe('StackRegistryClient', () => {
  it('tolerates a missing registry dir', async () => {
    const client = new StackRegistryClient(join(newTmpDir(), 'brokkr-local', 'stacks'));
    expect(client.list()).toEqual([]);
    expect(await client.ownerOfSlot(1)).toBeNull();
  });

  it('honors XDG_STATE_HOME for the default dir', () => {
    const root = newTmpDir();
    process.env.XDG_STATE_HOME = root;
    const dir = registryDir(root);
    writeEntry(dir, 4, { checkout: '/some/checkout' });
    expect(new StackRegistryClient().list().map((e) => e.slot)).toEqual([4]);
  });

  it('names the owner of a live entry', async () => {
    const dir = registryDir(newTmpDir());
    const checkout = newTmpDir();
    writeEntry(dir, 2, { checkout, pcSock: join(checkout, 'pc.sock'), pcDaemonPid: process.pid, state: 'up' });
    expect(await new StackRegistryClient(dir, async () => false).ownerOfSlot(2)).toBe(checkout);
  });

  it('treats an entry whose checkout dir is gone as stale', async () => {
    const dir = registryDir(newTmpDir());
    writeEntry(dir, 2, { checkout: join(newTmpDir(), 'deleted-checkout'), pcDaemonPid: process.pid });
    expect(await new StackRegistryClient(dir, async () => true).ownerOfSlot(2)).toBeNull();
  });

  it('treats an entry with a dead pid and a dead socket as stale', async () => {
    const dir = registryDir(newTmpDir());
    const checkout = newTmpDir();
    writeEntry(dir, 3, { checkout, pcSock: join(checkout, 'pc.sock'), pcDaemonPid: DEAD_PID, state: 'up' });
    expect(await new StackRegistryClient(dir, async () => false).ownerOfSlot(3)).toBeNull();
  });

  it('keeps an entry whose pid is dead while the socket still answers', async () => {
    const dir = registryDir(newTmpDir());
    const checkout = newTmpDir();
    const sock = join(checkout, 'pc.sock');
    writeFileSync(sock, '');
    writeEntry(dir, 3, { checkout, pcSock: sock, pcDaemonPid: DEAD_PID, state: 'up' });
    expect(await new StackRegistryClient(dir, async () => true).ownerOfSlot(3)).toBe(checkout);
  });

  it('keeps a pre-supervisor entry (pid 0, no socket) as owned', async () => {
    const dir = registryDir(newTmpDir());
    const checkout = newTmpDir();
    writeEntry(dir, 5, { checkout, pcDaemonPid: 0, state: 'up' });
    expect(await new StackRegistryClient(dir, async () => false).ownerOfSlot(5)).toBe(checkout);
  });

  it('skips entries that are not valid registry JSON', () => {
    const dir = registryDir(newTmpDir());
    writeFileSync(join(dir, 'stack-9.json'), 'not json{');
    writeEntry(dir, 1, { checkout: newTmpDir(), pcDaemonPid: 0 });
    expect(new StackRegistryClient(dir).list().map((e) => e.slot)).toEqual([1]);
  });
});
