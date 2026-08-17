import type { AgentOperationContext } from '@hydrahost/plugin-sdk';
import {
  getOperation,
  type CollectionResult,
  type OperationName,
  type WorkProgress,
} from '@repo/bridge-agent-protocol';
import type { z } from 'zod';

export type IntermediateMessage = WorkProgress | CollectionResult;

export interface HandlerContext extends AgentOperationContext {
  emit: (msg: IntermediateMessage) => Promise<void>;
  fetchArtifact?: (sha256: string, artifact: 'bundle' | 'unit' | 'config') => AsyncIterable<Uint8Array>;
  resultDelivered: Promise<void>;
}

export type Handler<TIn = unknown, TOut = unknown> = (input: TIn, ctx: HandlerContext) => Promise<TOut> | TOut;

interface Registration {
  input: z.ZodType;
  output: z.ZodType;
  handler: Handler;
}

const handlers = new Map<string, Registration>();

export function registerOperation<N extends OperationName>(
  name: N,
  handler: Handler<
    z.infer<(typeof import('@repo/bridge-agent-protocol').operations)[N]['input']>,
    z.infer<(typeof import('@repo/bridge-agent-protocol').operations)[N]['output']>
  >,
): void {
  const schema = getOperation(name);
  if (!schema) {
    throw new Error(`cannot register unknown operation: ${name}`);
  }
  if (handlers.has(name)) {
    throw new Error(`operation already registered: ${name}`);
  }
  handlers.set(name, {
    input: schema.input,
    output: schema.output,
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    handler: handler as Handler,
  });
}

export function registerPluginOperation(name: string, input: z.ZodType, output: z.ZodType, handler: Handler): void {
  if (handlers.has(name)) {
    throw new Error(`operation already registered: ${name}`);
  }
  handlers.set(name, { input, output, handler });
}

export function getHandler(name: string): Registration | undefined {
  return handlers.get(name);
}

export function clearOperationsForTests(): void {
  handlers.clear();
}

export function replaceOperationForTests(name: string, handler: Handler): void {
  const existing = handlers.get(name);
  if (!existing) {
    throw new Error(`cannot replace unregistered operation: ${name}`);
  }
  handlers.set(name, { input: existing.input, output: existing.output, handler });
}
