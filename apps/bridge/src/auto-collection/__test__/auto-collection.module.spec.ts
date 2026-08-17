import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { ContextLogger } from '../../logger/logger.service.js';
import { AutoCollectionModule } from '../auto-collection.module.js';
import {
  AUTO_COLLECTION_CACHE,
  AUTO_COLLECTION_ENQUEUE,
  AUTO_COLLECTION_READ_ATOM,
} from '../auto-collection.service.js';

const FAKE_CACHE = Symbol('FAKE_CACHE');
const FAKE_READ_ATOM = Symbol('FAKE_READ_ATOM');
const FAKE_ENQUEUE = Symbol('FAKE_ENQUEUE');

const fakeCache = {
  exists: vi.fn(async () => false),
  get: vi.fn(async () => null),
  setNxOwned: vi.fn(async () => true),
  delete: vi.fn(async () => 1),
};
const fakeReadAtom = vi.fn(async () => null);
const fakeEnqueue = vi.fn(async () => true);

@Global()
@Module({
  providers: [
    { provide: FAKE_CACHE, useValue: fakeCache },
    { provide: FAKE_READ_ATOM, useValue: fakeReadAtom },
    { provide: FAKE_ENQUEUE, useValue: fakeEnqueue },
    { provide: ContextLogger, useValue: new ContextLogger() },
  ],
  exports: [FAKE_CACHE, FAKE_READ_ATOM, FAKE_ENQUEUE, ContextLogger],
})
class FakeDepsModule {}

describe('AutoCollectionModule.forRoot', () => {
  it('token-form: resolves cache + readAtom + enqueuer from DI tokens', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeDepsModule,
        AutoCollectionModule.forRoot({
          cacheToken: FAKE_CACHE,
          readAtomToken: FAKE_READ_ATOM,
          enqueueCollectionJobToken: FAKE_ENQUEUE,
        }),
      ],
    }).compile();

    expect(moduleRef.get(AUTO_COLLECTION_CACHE)).toBe(fakeCache);
    expect(moduleRef.get(AUTO_COLLECTION_READ_ATOM)).toBe(fakeReadAtom);
    expect(moduleRef.get(AUTO_COLLECTION_ENQUEUE)).toBe(fakeEnqueue);

    await moduleRef.close();
  });

  it('value-form: legacy deps() callable still works', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        FakeDepsModule,
        AutoCollectionModule.forRoot({
          deps: () => ({
            cache: fakeCache,
            readAtom: fakeReadAtom,
            enqueueCollectionJob: fakeEnqueue,
          }),
        }),
      ],
    }).compile();

    expect(moduleRef.get(AUTO_COLLECTION_CACHE)).toBe(fakeCache);
    expect(moduleRef.get(AUTO_COLLECTION_READ_ATOM)).toBe(fakeReadAtom);
    expect(moduleRef.get(AUTO_COLLECTION_ENQUEUE)).toBe(fakeEnqueue);

    await moduleRef.close();
  });
});
