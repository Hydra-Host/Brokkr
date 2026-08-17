import { describe, expect, it } from 'vitest';
import { createLabContext } from './client.js';
import { collectRunLogs, runAndCollect, waitForRun } from './runs.js';
import { runFixture, stubApi, stubFetch } from './testkit.js';

describe('waitForRun', () => {
  it('polls until the run reaches a terminal status', async () => {
    const ctx = createLabContext({
      baseUrl: 'http://lab.test',
      api: stubApi({
        'GET /api/runs/r1': [
          { status: 200, body: runFixture() },
          { status: 200, body: runFixture({ status: 'passed', finishedAt: 10, exitCode: 0 }) },
        ],
      }),
    });
    const run = await waitForRun(ctx.client, 'r1', { pollMs: 1 });
    expect(run.status).toBe('passed');
  });

  it('times out while the run is still running', async () => {
    const ctx = createLabContext({
      baseUrl: 'http://lab.test',
      api: stubApi({
        'GET /api/runs/r1': { status: 200, body: runFixture() },
      }),
    });
    await expect(waitForRun(ctx.client, 'r1', { pollMs: 1, timeoutMs: 5 })).rejects.toThrow('run r1 still running');
  });

  it('propagates api errors via failOnError', async () => {
    const ctx = createLabContext({
      baseUrl: 'http://lab.test',
      api: stubApi({ 'GET /api/runs/r1': { status: 404, body: { error: 'unknown run' } } }),
    });
    await expect(waitForRun(ctx.client, 'r1', { pollMs: 1 })).rejects.toThrow('getRun: unknown run');
  });
});

describe('collectRunLogs', () => {
  it('collects line frames until the done sentinel', async () => {
    const ctx = createLabContext({
      baseUrl: 'http://lab.test',
      api: stubApi({}),
      fetchImpl: stubFetch({
        '/api/runs/r1/stream': 'data: {"line":"hello "}\n\ndata: {"line":"world"}\n\ndata: {"done":true}\n\n',
      }),
    });
    const logs = await collectRunLogs(ctx, 'r1');
    expect(logs).toEqual({ log: 'hello world', done: true, truncated: false });
  });

  it('reports done=false when the stream ends without the sentinel', async () => {
    const ctx = createLabContext({
      baseUrl: 'http://lab.test',
      api: stubApi({}),
      fetchImpl: stubFetch({ '/api/runs/r1/stream': 'data: {"line":"partial"}\n\n' }),
    });
    const logs = await collectRunLogs(ctx, 'r1');
    expect(logs.done).toBe(false);
    expect(logs.log).toBe('partial');
  });

  it('keeps only the tail when over the cap', async () => {
    const ctx = createLabContext({
      baseUrl: 'http://lab.test',
      api: stubApi({}),
      fetchImpl: stubFetch({ '/api/runs/r1/stream': 'data: {"line":"abcdefghij"}\n\ndata: {"done":true}\n\n' }),
    });
    const logs = await collectRunLogs(ctx, 'r1', { maxChars: 4 });
    expect(logs).toEqual({ log: 'ghij', done: true, truncated: true });
  });
});

describe('runAndCollect', () => {
  it('returns the runId immediately when wait is false', async () => {
    const ctx = createLabContext({ baseUrl: 'http://lab.test', api: stubApi({}) });
    const result = await runAndCollect(ctx, async () => 'r9', { wait: false });
    expect(result).toEqual({ runId: 'r9' });
  });

  it('waits and returns final run state plus logs when wait is true', async () => {
    const ctx = createLabContext({
      baseUrl: 'http://lab.test',
      api: stubApi({ 'GET /api/runs/r1': { status: 200, body: runFixture({ status: 'passed' }) } }),
      fetchImpl: stubFetch({ '/api/runs/r1/stream': 'data: {"line":"done-log"}\n\ndata: {"done":true}\n\n' }),
    });
    const result = await runAndCollect(ctx, async () => 'r1', { wait: true, timeoutMs: 1000 });
    expect(result).toEqual({
      run: runFixture({ status: 'passed' }),
      logs: { log: 'done-log', done: true, truncated: false },
    });
  });
});
