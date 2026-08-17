import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../exec', () => ({
  run: vi.fn().mockResolvedValue({ exit_code: 0, stdout: '', stderr: '' }),
}));

import { scheduleExit } from '../upgrade-exit';

describe('scheduleExit resultDelivered contract', () => {
  const realExit = process.exit;
  let exitCalls: Array<number | string | null | undefined> = [];

  beforeEach(() => {
    exitCalls = [];
    process.exit = ((code?: number | string | null) => {
      exitCalls.push(code ?? undefined);
    }) as unknown as typeof process.exit;
  });

  afterEach(() => {
    process.exit = realExit;
  });

  it('calls process.exit(0) after drain resolves', async () => {
    scheduleExit(false, Promise.resolve());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(exitCalls).toEqual([0]);
  });

  it('does NOT call process.exit when drain rejects', async () => {
    scheduleExit(false, Promise.reject(new Error('all bridges unreachable')));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(exitCalls).toEqual([]);
  });

  it('does NOT call process.exit when drain rejects even with unitReplaced=true', async () => {
    scheduleExit(true, Promise.reject(new Error('all bridges unreachable')));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(exitCalls).toEqual([]);
  });
});
