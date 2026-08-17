import { Logger, NotFoundException } from '@nestjs/common';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunLogStore, runLogPath } from '../run-log-store';

const UNSAFE_RUN_IDS = [
  '',
  '.',
  '..',
  '../../../../etc/hosts',
  'a/b',
  'a\\b',
  '/etc/passwd',
  'C:\\windows\\system32',
  '..%2F..%2Fsecret',
  '-leading-dash',
  'has space',
  'nul\0byte',
];

const MARKER = '[... further output truncated ...]';

let stateDir: string;
let store: RunLogStore;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'lab-run-logs-'));
  vi.stubEnv('LOCAL_STATE', stateDir);
  store = new RunLogStore();
});

afterEach(async () => {
  await store.onApplicationShutdown();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

async function contentsOf(runId: string, expected: string): Promise<string> {
  await vi.waitFor(() => expect(readFileSync(runLogPath(runId), 'utf8')).toContain(expected));
  return readFileSync(runLogPath(runId), 'utf8');
}

describe('RunLogStore', () => {
  it('creates nothing until a run produces output', () => {
    expect(existsSync(join(stateDir, 'lab', 'runs'))).toBe(false);
    expect(store.finish('never-ran')).toEqual({ bytes: 0, truncated: false });
    expect(existsSync(join(stateDir, 'lab', 'runs'))).toBe(false);
  });

  it('appends every chunk of a run to one flat file', async () => {
    store.append('run-a', 'first\r\n');
    store.append('run-a', 'second\r\n');

    expect(store.finish('run-a')).toEqual({ bytes: 15, truncated: false });
    expect(await contentsOf('run-a', 'second')).toBe('first\r\nsecond\r\n');
  });

  it('keeps runs in separate files', async () => {
    store.append('run-a', 'aaa');
    store.append('run-b', 'bbb');
    store.finish('run-a');
    store.finish('run-b');

    expect(await contentsOf('run-a', 'aaa')).toBe('aaa');
    expect(await contentsOf('run-b', 'bbb')).toBe('bbb');
  });

  it('counts utf-8 bytes, not code units', async () => {
    store.append('run-utf8', '✓');

    expect(store.finish('run-utf8')).toEqual({ bytes: 3, truncated: false });
    expect(await contentsOf('run-utf8', '✓')).toBe('✓');
  });

  it('emits exactly one truncation marker at the 8 MiB default cap and then stops growing', async () => {
    const chunk = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 9; i += 1) store.append('run-big', chunk);
    store.append('run-big', 'after-the-cap');
    const finished = store.finish('run-big');

    expect(finished.truncated).toBe(true);
    expect(finished.bytes).toBe(9 * 1024 * 1024 + Buffer.byteLength(`\r\n${MARKER}\r\n`));
    await vi.waitFor(() => expect(statSync(runLogPath('run-big')).size).toBe(finished.bytes));
    const body = readFileSync(runLogPath('run-big'), 'utf8');
    expect(body.split(MARKER).length - 1).toBe(1);
    expect(body.slice(-200).includes('after-the-cap')).toBe(false);
  });

  it('honours LAB_RUN_LOG_MAX_BYTES', async () => {
    vi.stubEnv('LAB_RUN_LOG_MAX_BYTES', '10');
    store.append('run-small', 'abcdefghijk');
    store.append('run-small', 'dropped');

    expect(store.finish('run-small')).toEqual({ bytes: 11 + Buffer.byteLength(`\r\n${MARKER}\r\n`), truncated: true });
    const body = await contentsOf('run-small', MARKER);
    expect(body.startsWith('abcdefghijk')).toBe(true);
    expect(body).not.toContain('dropped');
  });

  it('falls back to the default cap for a nonsense override', async () => {
    vi.stubEnv('LAB_RUN_LOG_MAX_BYTES', 'not-a-number');
    store.append('run-default', 'y'.repeat(1024));

    expect(store.finish('run-default')).toEqual({ bytes: 1024, truncated: false });
    expect((await contentsOf('run-default', 'yyy')).length).toBe(1024);
  });

  it('reports zero for a run whose log was already finished', async () => {
    store.append('run-once', 'data');
    store.finish('run-once');
    await contentsOf('run-once', 'data');

    expect(store.finish('run-once')).toEqual({ bytes: 0, truncated: false });
  });

  it('drops output that arrives after the run finished', async () => {
    store.append('run-late', 'before\r\n');

    expect(store.finish('run-late')).toEqual({ bytes: 8, truncated: false });
    const body = await contentsOf('run-late', 'before');
    store.append('run-late', 'after\r\n');

    expect(store.finish('run-late')).toEqual({ bytes: 0, truncated: false });
    expect(readFileSync(runLogPath('run-late'), 'utf8')).toBe(body);
    expect(statSync(runLogPath('run-late')).size).toBe(8);
  });

  it('logs again for a run id whose file was removed', async () => {
    store.append('run-recycled', 'first');
    store.finish('run-recycled');
    await contentsOf('run-recycled', 'first');

    expect(store.remove('run-recycled')).toBe(true);
    store.append('run-recycled', 'second');

    expect(store.finish('run-recycled')).toEqual({ bytes: 6, truncated: false });
    expect(await contentsOf('run-recycled', 'second')).toBe('second');
  });

  it('flushes and closes every open stream on shutdown', async () => {
    store.append('run-open-1', 'one');
    store.append('run-open-2', 'two');

    await store.onApplicationShutdown();

    expect(readFileSync(runLogPath('run-open-1'), 'utf8')).toBe('one');
    expect(readFileSync(runLogPath('run-open-2'), 'utf8')).toBe('two');
    expect(store.finish('run-open-1')).toEqual({ bytes: 0, truncated: false });
  });

  it('has a buffered run fully on disk once the shutdown hook resolves', async () => {
    const buffered = 'z'.repeat(512 * 1024);
    store.append('run-buffered', buffered);

    await store.onApplicationShutdown();

    expect(readFileSync(runLogPath('run-buffered'), 'utf8')).toBe(buffered);
  });

  it('has a run finished moments before the shutdown hook fully on disk too', async () => {
    const buffered = 'z'.repeat(512 * 1024);
    store.append('run-raced', buffered);
    expect(store.finish('run-raced')).toEqual({ bytes: buffered.length, truncated: false });

    await store.onApplicationShutdown();

    expect(readFileSync(runLogPath('run-raced'), 'utf8')).toBe(buffered);
  });

  it('stops writing and counting once the stream reports a failure', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    mkdirSync(join(stateDir, 'lab', 'runs'), { recursive: true });
    mkdirSync(runLogPath('run-eisdir'));

    store.append('run-eisdir', 'first');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('run-eisdir.log failed')));
    store.append('run-eisdir', 'x'.repeat(4096));

    expect(store.finish('run-eisdir')).toEqual({ bytes: 0, truncated: false });
  });

  it('refuses a traversal that would otherwise resolve to a log outside the run directory', () => {
    writeFileSync(join(stateDir, 'secret.log'), 'secret');

    expect(runLogPath('run-a')).toBe(join(stateDir, 'lab', 'runs', 'run-a.log'));
    expect(() => store.read('../../secret')).toThrow(NotFoundException);
  });

  it('survives an unwritable state directory', () => {
    const blocker = join(stateDir, 'blocker');
    writeFileSync(blocker, 'not a directory');
    vi.stubEnv('LOCAL_STATE', blocker);

    expect(() => store.append('run-blocked', 'nowhere')).not.toThrow();
    expect(() => store.append('run-blocked', 'still nowhere')).not.toThrow();
    expect(store.finish('run-blocked')).toEqual({ bytes: 0, truncated: false });
  });
});

describe('RunLogStore.remove', () => {
  it.each(UNSAFE_RUN_IDS)('skips %j instead of throwing out of a retention sweep', (runId) => {
    expect(store.remove(runId)).toBe(false);
  });

  it('removes the log of a run id that clears the guard', async () => {
    store.append('run-doomed', 'output');
    await contentsOf('run-doomed', 'output');
    store.finish('run-doomed');

    expect(store.remove('run-doomed')).toBe(true);
    expect(existsSync(runLogPath('run-doomed'))).toBe(false);
  });
});

describe('runLogPath', () => {
  it.each(UNSAFE_RUN_IDS)('rejects %j rather than rewriting it to another file', (runId) => {
    expect(() => runLogPath(runId)).toThrow(NotFoundException);
  });

  it.each(['run-a', 'a', '0', 'A.B_c-1', '0f7a2c8e-6b1d-4d3a-9a5e-2c1b0d9e8f7a'])('accepts %j', (runId) => {
    expect(runLogPath(runId)).toBe(join(stateDir, 'lab', 'runs', `${runId}.log`));
  });
});
