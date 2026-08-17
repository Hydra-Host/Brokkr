import { z } from 'zod';
import { operations as agent } from './agent.js';
import { operations as benchmark } from './benchmark.js';
import { operations as collection } from './collection.js';
import { operations as deploy } from './deploy.js';
import { operations as diagnostic } from './diagnostic.js';
import { operations as storage } from './storage.js';
import { operations as system } from './system.js';
import { operations as test } from './test.js';

function prefix<N extends string, T extends Record<string, unknown>>(ns: N, ops: T) {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return Object.fromEntries(Object.entries(ops).map(([k, v]) => [`${ns}.${k}`, v])) as {
    [K in keyof T as `${N}.${string & K}`]: T[K];
  };
}

export const operations = {
  ...prefix('agent', agent),
  ...prefix('system', system),
  ...prefix('collection', collection),
  ...prefix('storage', storage),
  ...prefix('deploy', deploy),
  ...prefix('benchmark', benchmark),
  ...prefix('test', test),
  ...prefix('diagnostic', diagnostic),
} as const;

export type OperationName = keyof typeof operations;

export type OperationInput<N extends OperationName> = z.infer<(typeof operations)[N]['input']>;

export type OperationOutput<N extends OperationName> = z.infer<(typeof operations)[N]['output']>;

export function getOperation(name: string) {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return (operations as Record<string, { input: z.ZodType; output: z.ZodType }>)[name];
}
