import { describe, expect, it, vi } from 'vitest';

import { InitrdModule } from '../initrd.module.js';

const TOKEN = Symbol('test enqueue token');

describe('InitrdModule.forRoot — cache field', () => {
  it('token-form path: `cache` is omitted and forRoot resolves without throwing', () => {
    const moduleDef = InitrdModule.forRoot({
      enqueueRenderRequestToken: TOKEN,
    });
    expect(moduleDef.module).toBe(InitrdModule);
    expect(moduleDef.providers).toBeDefined();
  });

  it('value-form path: omitting `cache` throws a clear error', () => {
    expect(() =>
      InitrdModule.forRoot({
        enqueueRenderRequest: vi.fn(async () => false),
      }),
    ).toThrowError(/`cache` is required on the value-form path/);
  });

  it('value-form path: supplying `cache` and `enqueueRenderRequest` resolves', () => {
    const cache = {} as Parameters<typeof InitrdModule.forRoot>[0]['cache'];
    const moduleDef = InitrdModule.forRoot({
      cache,
      enqueueRenderRequest: vi.fn(async () => false),
    });
    expect(moduleDef.module).toBe(InitrdModule);
  });
});
