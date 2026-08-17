import type { Run } from '@repo/local-lab-contract';
import { z } from 'zod';
import type { LabClient, LabContext } from './client.js';
import labContractPkg from './lab-contract.js';
import { failOnError } from './shared.js';

const { LogLineEventSchema, StreamDoneEventSchema, parseSseEvent, streamPaths } = labContractPkg;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['passed', 'failed', 'cancelled']);

export const waitShape = {
  wait: z
    .boolean()
    .default(true)
    .describe(
      'Wait for the run to reach a terminal status and return its final state plus log tail; false returns the runId immediately for manual polling',
    ),
  timeoutMs: z
    .number()
    .int()
    .min(1000)
    .optional()
    .describe('Maximum wait in ms when wait is true (default 30 minutes)'),
};

export interface WaitForRunOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export async function waitForRun(client: LabClient, runId: string, options: WaitForRunOptions = {}): Promise<Run> {
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const pollMs = options.pollMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await client.getRun({ params: { runId } });
    failOnError(res, 'getRun');
    if (TERMINAL_STATUSES.has(res.body.status)) return res.body;
    if (Date.now() >= deadline) {
      throw new Error(`run ${runId} still ${res.body.status} after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export interface RunLogs {
  log: string;
  done: boolean;
  truncated: boolean;
}

export async function collectRunLogs(
  ctx: LabContext,
  runId: string,
  options: { maxChars?: number } = {},
): Promise<RunLogs> {
  const maxChars = options.maxChars ?? 64 * 1024;
  const res = await ctx.fetchImpl(`${ctx.baseUrl}${streamPaths.run(runId)}`, {
    headers: ctx.token ? { 'x-lab-token': ctx.token } : {},
  });
  if (!res.ok || !res.body) throw new Error(`run log stream: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let log = '';
  let done = false;
  for (;;) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      if (parseSseEvent(StreamDoneEventSchema, data)) {
        done = true;
        break;
      }
      const event = parseSseEvent(LogLineEventSchema, data);
      if (event) log += event.line;
    }
    if (done) break;
  }
  await reader.cancel().catch(() => undefined);
  const truncated = log.length > maxChars;
  return { log: truncated ? log.slice(-maxChars) : log, done, truncated };
}

export async function runAndCollect(
  ctx: LabContext,
  start: () => Promise<string>,
  args: { wait: boolean; timeoutMs?: number },
): Promise<unknown> {
  const runId = await start();
  if (!args.wait) return { runId };
  const run = await waitForRun(ctx.client, runId, { timeoutMs: args.timeoutMs });
  const logs = await collectRunLogs(ctx, runId);
  return { run, logs };
}
