import type { ApiFetcherArgs } from '@ts-rest/core';
import { z } from 'zod';

const RESPONSE_START = '\x00BROKKR_RES:';
const RESPONSE_END = '\x00';

const BRIDGE_TIMEOUT_MS = 30_000;

interface PendingRequest {
  resolve: (value: BridgeResponse) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const BridgeResponseSchema = z.object({
  id: z.string(),
  status: z.number(),
  headers: z.record(z.string()).default({}),
  body: z.string(),
});

type BridgeResponse = z.infer<typeof BridgeResponseSchema>;

const pendingRequests = new Map<string, PendingRequest>();
let requestCounter = 0;
const MAX_STDIN_BUFFER = 50 * 1024 * 1024;
let stdinBuffer = '';
let stdinListenerAttached = false;

function attachStdinListener(): void {
  if (stdinListenerAttached) return;
  stdinListenerAttached = true;

  process.stdin.setEncoding('utf-8');
  process.stdin.resume();

  process.stdin.on('data', (chunk: string) => {
    stdinBuffer += chunk;
    if (stdinBuffer.length > MAX_STDIN_BUFFER) {
      console.error('Bridge buffer overflow — aborting');
      process.exit(1);
    }
    drainResponses();
  });
}

function drainResponses(): void {
  while (true) {
    const startIdx = stdinBuffer.indexOf(RESPONSE_START);
    if (startIdx === -1) break;

    const jsonStart = startIdx + RESPONSE_START.length;
    const endIdx = stdinBuffer.indexOf(RESPONSE_END, jsonStart);
    if (endIdx === -1) {
      stdinBuffer = stdinBuffer.slice(startIdx);
      return;
    }

    const responseJson = stdinBuffer.slice(jsonStart, endIdx);
    stdinBuffer = stdinBuffer.slice(endIdx + RESPONSE_END.length);

    try {
      const response = BridgeResponseSchema.parse(JSON.parse(responseJson));
      const pending = pendingRequests.get(response.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(response.id);
        pending.resolve(response);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Bridge: discarded malformed response — ${message}\n`);
    }
  }
}

export async function bridgeApiFetcher(
  args: ApiFetcherArgs,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  attachStdinListener();

  const id = `req_${++requestCounter}`;

  const request = {
    id,
    method: args.method,
    url: args.path,
    headers: args.headers,
    body: args.body ?? null,
  };

  const responsePromise = new Promise<BridgeResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Bridge request timed out after ${BRIDGE_TIMEOUT_MS}ms`));
    }, BRIDGE_TIMEOUT_MS);

    pendingRequests.set(id, { resolve, reject, timer });
  });

  process.stdout.write(`\x00BROKKR_REQ:${JSON.stringify(request)}\x00`);

  const response = await responsePromise;

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(response.body);
  } catch {
    parsedBody = response.body;
  }

  return {
    status: response.status,
    body: parsedBody,
    headers: new Headers(response.headers ?? {}),
  };
}
