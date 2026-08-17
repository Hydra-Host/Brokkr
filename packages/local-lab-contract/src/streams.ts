import { z } from 'zod';

// SSE/WS paths live outside the ts-rest router (it can't model streaming); these builders + frame
// schemas are the one source of truth shared with the lab @Sse/@WebSocket controllers.
export const streamPaths = {
  /** SSE: live log of any run in any section; replays the persisted log for a run the API no longer holds. */
  run: (runId: string) => `/api/runs/${encodeURIComponent(runId)}/stream`,
  /** SSE: merged logs of the supervised fleet processes (fleet:init build + fleet supervisor). */
  fleetProcessLogs: () => '/api/fleet/process-logs/stream',
  /** SSE: live log of one bring-up init task; the name is validated against the derived roster. */
  stackInitLog: (name: string) => `/api/stack/init/${encodeURIComponent(name)}/log`,
  /** SSE: structured event timeline for a test run. */
  testEvents: (runId: string) => `/api/tests/runs/${encodeURIComponent(runId)}/events/stream`,
  /** WebSocket: interactive serial console for a fleet VM. */
  fleetShell: (node: string) => `/api/fleet/shell?node=${encodeURIComponent(node)}`,
} as const;

// binary downloads live outside the ts-rest router for the same reason as the SSE paths above — it models JSON bodies, not raw file streams.
export const downloadPaths = {
  /** Raw text attachment (per-run log slice) of a test run. */
  testAttachment: (runId: string, source: string) =>
    `/api/tests/runs/${encodeURIComponent(runId)}/attachment?source=${encodeURIComponent(source)}`,
} as const;

// the lab @Sse log routes emit { line } frames — no distinct error frame (drops surface at the
// EventSource transport, not as a payload); finite run streams also end with one { done: true } frame (below).
export const LogLineEventSchema = z.object({
  line: z.string().describe('A chunk of log output; may carry ANSI escapes and embedded newlines'),
});
export type LogLineEvent = z.infer<typeof LogLineEventSchema>;

// the browser reports a normal close and a drop identically (EventSource `onerror`), so finite run
// streams end with this sentinel: seen it → completed; close without → a drop worth retrying (tails never emit it).
export const StreamDoneEventSchema = z.object({
  done: z.literal(true).describe('Marks the normal end of a finite run stream; the server closes right after'),
});
export type StreamDoneEvent = z.infer<typeof StreamDoneEventSchema>;

/** parse one SSE `event.data` payload against a frame schema. Returns null for non-JSON or a frame
 *  that doesn't match — callers drop those rather than trusting an unvalidated shape. */
export function parseSseEvent<T>(schema: z.ZodType<T>, raw: string): T | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = schema.safeParse(json);
  return result.success ? result.data : null;
}
