import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Run } from '@repo/local-lab-contract';
import { createLabContext, type LabApiFetcher } from './client.js';
import { registerAllTools } from './tools/index.js';

export interface StubCall {
  method: string;
  path: string;
  body: unknown;
}

export interface StubRoute {
  status: number;
  body: unknown;
}

export function stubApi(routes: Record<string, StubRoute | StubRoute[]>, calls: StubCall[] = []): LabApiFetcher {
  const queue = new Map(
    Object.entries(routes).map(([key, route]) => [key, Array.isArray(route) ? [...route] : [route]]),
  );
  const fetcher: LabApiFetcher = async (args) => {
    calls.push({ method: args.method, path: args.path, body: args.rawBody });
    // args.path is the full url (baseUrl + path + query) — match on pathname only, ignoring
    // both the host and the query string, so stub keys stay short (e.g. 'GET /api/runs').
    const key = `${args.method} ${new URL(args.path).pathname}`;
    const routeQueue = queue.get(key);
    if (!routeQueue || routeQueue.length === 0) throw new Error(`no stub for ${key}`);
    // shift through a multi-response sequence, but a single response (or the last of a sequence)
    // repeats for every further call — needed so a poll loop can hit the same stub repeatedly.
    const route = routeQueue.length > 1 ? routeQueue.shift() : routeQueue[0];
    if (!route) throw new Error(`no stub for ${key}`);
    return { status: route.status, body: route.body, headers: new Headers() };
  };
  return fetcher;
}

export function stubFetch(sseByPath: Record<string, string> = {}): typeof fetch {
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    const payload = Object.entries(sseByPath).find(([path]) => url.includes(path))?.[1] ?? 'data: {"done":true}\n\n';
    return new Response(new TextEncoder().encode(payload), { status: 200 });
  };
  return impl;
}

export function runFixture(overrides: Partial<Run> = {}): Run {
  return {
    runId: 'r1',
    section: 'stack',
    opId: 'reconcile',
    label: 'reconcile',
    status: 'running',
    startedAt: 0,
    finishedAt: null,
    exitCode: null,
    nodeIndex: null,
    origin: null,
    hasLog: true,
    hasResult: false,
    ...overrides,
  };
}

export async function createTestServer(
  api: LabApiFetcher,
  options: { allowDestructive?: boolean; sseByPath?: Record<string, string> } = {},
) {
  const server = new McpServer({ name: 'brokkr-lab-test', version: '0.0.0' });
  registerAllTools(
    server,
    createLabContext({ baseUrl: 'http://lab.test', api, fetchImpl: stubFetch(options.sseByPath) }),
    { allowDestructive: options.allowDestructive ?? false },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'brokkr-lab-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}
