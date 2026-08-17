import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, access: vi.fn(), readFile: vi.fn() };
});

import { access, readFile } from 'node:fs/promises';
import { clearOperationsForTests, getHandler } from '../../../dispatch/registry';
import { run } from '../../../exec';
import { registerGhwCollector } from '../ghw';

const runMock = vi.mocked(run);
const accessMock = vi.mocked(access);
const readFileMock = vi.mocked(readFile);
const ctx = {} as never;

interface GhwDisk {
  name: string;
  size_bytes: number;
}

function scriptGhwc(disks: GhwDisk[]): void {
  runMock.mockImplementation(async (_cmd, args) => {
    const fact = args?.[0];
    const payload =
      fact === 'block' ? { block: { total_size_bytes: disks.reduce((s, d) => s + d.size_bytes, 0), disks } } : {};
    return { stdout: JSON.stringify(payload), stderr: '', exit_code: 0, duration_ms: 0 };
  });
}

function scriptHidden(hidden: Record<string, string>): void {
  readFileMock.mockImplementation(async (path) => {
    const match = /^\/sys\/block\/(.+)\/hidden$/.exec(String(path));
    const value = match ? hidden[match[1]!] : undefined;
    if (value === undefined) throw new Error(`ENOENT: ${String(path)}`);
    return value;
  });
}

async function collectBlock(): Promise<{ total_size_bytes: number; disks: GhwDisk[] }> {
  const handler = getHandler('collection.ghw')!.handler;
  const result = (await handler({}, ctx)) as { ghw_block: { block: { total_size_bytes: number; disks: GhwDisk[] } } };
  return result.ghw_block.block;
}

beforeEach(() => {
  runMock.mockReset();
  accessMock.mockReset();
  readFileMock.mockReset();
  accessMock.mockResolvedValue(undefined);
  clearOperationsForTests();
  registerGhwCollector();
});

describe('collection.ghw block fact', () => {
  it('drops hidden multipath siblings and recomputes the capacity total, which double-counted them', async () => {
    scriptGhwc([
      { name: 'nvme2n1', size_bytes: 1_000 },
      { name: 'nvme2c2n1', size_bytes: 1_000 },
      { name: 'sda', size_bytes: 500 },
    ]);
    scriptHidden({ nvme2n1: '0\n', nvme2c2n1: '1\n', sda: '0\n' });

    const block = await collectBlock();

    expect(block.disks.map((d) => d.name)).toEqual(['nvme2n1', 'sda']);
    expect(block.total_size_bytes).toBe(1_500);
  });

  it('falls back to the nvmeXcYnZ name shape when sysfs has no hidden attr', async () => {
    scriptGhwc([
      { name: 'nvme0n1', size_bytes: 1_000 },
      { name: 'nvme0c0n1', size_bytes: 1_000 },
    ]);
    scriptHidden({});

    const block = await collectBlock();

    expect(block.disks.map((d) => d.name)).toEqual(['nvme0n1']);
  });

  it('keeps every disk when none is hidden', async () => {
    const disks = [
      { name: 'nvme0n1', size_bytes: 1_000 },
      { name: 'sda', size_bytes: 500 },
    ];
    scriptGhwc(disks);
    scriptHidden({ nvme0n1: '0', sda: '0' });

    const block = await collectBlock();

    expect(block.disks).toEqual(disks);
    expect(block.total_size_bytes).toBe(1_500);
  });
});
