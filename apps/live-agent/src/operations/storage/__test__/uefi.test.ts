import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, access: vi.fn() };
});

import { access } from 'node:fs/promises';
import { clearOperationsForTests, getHandler } from '../../../dispatch/registry';
import { registerUefiDetector } from '../uefi';

const accessMock = vi.mocked(access);
const ctx = {} as never;

function errno(code: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(code);
  err.code = code;
  return err;
}

async function detect(): Promise<{ uefi_mode: boolean }> {
  const handler = getHandler('storage.detectUefiMode')!.handler;
  return (await handler({}, ctx)) as { uefi_mode: boolean };
}

beforeEach(() => {
  accessMock.mockReset();
  clearOperationsForTests();
  registerUefiDetector();
});

describe('storage.detectUefiMode', () => {
  it('reports uefi_mode true when /sys/firmware/efi is present', async () => {
    accessMock.mockResolvedValue(undefined);
    expect(await detect()).toEqual({ uefi_mode: true });
  });

  it('reports uefi_mode false when the path is absent (ENOENT) — legacy BIOS', async () => {
    accessMock.mockRejectedValue(errno('ENOENT'));
    expect(await detect()).toEqual({ uefi_mode: false });
  });

  it('defaults to uefi_mode true on an indeterminate probe error (EACCES)', async () => {
    accessMock.mockRejectedValue(errno('EACCES'));
    expect(await detect()).toEqual({ uefi_mode: true });
  });
});
