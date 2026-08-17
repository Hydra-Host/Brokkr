import { EventEmitter } from 'events';
import { vi } from 'vitest';

vi.mock('ioredis', () => {
  const createPipelineStub = () => {
    const pipeline = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') return undefined;
          if (prop === 'exec') return () => Promise.resolve([]);
          return () => pipeline;
        },
      },
    );
    return pipeline;
  };

  class RedisMock extends EventEmitter {
    status = 'ready';
    options: Record<string, unknown> = {};

    constructor() {
      super();
      return new Proxy(this, {
        get(target, prop, receiver) {
          if (prop in target || typeof prop === 'symbol') {
            return Reflect.get(target, prop, receiver);
          }
          if (prop === 'then') return undefined;
          if (prop === 'pipeline' || prop === 'multi') return () => createPipelineStub();
          return () => Promise.resolve(null);
        },
      });
    }

    connect() {
      return Promise.resolve();
    }

    disconnect() {}

    quit() {
      return Promise.resolve('OK');
    }
  }

  return { default: RedisMock, Redis: RedisMock };
});

vi.mock('bullmq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bullmq')>();
  const permissive = () => {
    const ee = new EventEmitter();
    return new Proxy(ee, {
      get(target, prop, receiver) {
        if (prop in target || typeof prop === 'symbol') {
          return Reflect.get(target, prop, receiver);
        }
        if (prop === 'then') return undefined;
        return () => Promise.resolve();
      },
    });
  };
  const stub = new Proxy(function BullStub() {}, {
    apply: () => permissive(),
    construct: () => permissive(),
    get: (target, prop) => {
      if (prop === 'then') return undefined;
      return prop === 'prototype' ? Reflect.get(target, prop) : stub;
    },
  });

  return {
    ...actual,
    Queue: stub,
    Worker: stub,
    Job: stub,
    FlowProducer: stub,
    QueueEvents: stub,
  };
});
