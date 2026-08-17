import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContextLogger } from '../../logger/logger.service';
import {
  getPartitioner,
  installPartitioner as installPartitionerSingleton,
} from '../../monitoring/common/partitioning';
import { TelegrafConfigWriterService } from '../../monitoring/telegraf/telegraf-config-writer.service';
import { TelegrafRuntimeService } from '../../monitoring/telegraf/telegraf-runtime.service';
import { TelegrafModule } from '../../monitoring/telegraf/telegraf.module';
import { buildTelegrafFactory, getTelegrafConfig, type TelegrafCache } from '../telegraf-factory';
import { resetTelegrafFactoryForTests } from '../telegraf-singleton';

@Global()
@Module({
  providers: [{ provide: ContextLogger, useValue: new ContextLogger() }],
  exports: [ContextLogger],
})
class LoggerStubModule {}

class EmptyCache implements TelegrafCache {
  async secretHget(): Promise<string | null> {
    return null;
  }
  async get(): Promise<string | null> {
    return null;
  }
  async scan(): Promise<string[]> {
    return [];
  }
}

function clearPartitionerSingleton(): void {
  installPartitionerSingleton({
    owns: () => false,
    start: async () => {},
    stop: async () => {},
  } as unknown as Parameters<typeof installPartitionerSingleton>[0]);
}

describe('telegraf factory composition', () => {
  let tmpDir: string;

  beforeEach(() => {
    resetTelegrafFactoryForTests();
    tmpDir = mkdtempSync(join(tmpdir(), 'telegraf-factory-'));
  });

  afterEach(() => {
    resetTelegrafFactoryForTests();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch (error) {
      void error;
    }
  });

  it('builds TelegrafModuleOptions that TelegrafModule.forRoot resolves end-to-end', async () => {
    const env = { TELEGRAF_OWNED_CONF_PATH: join(tmpDir, 'owned.conf') };
    const handle = buildTelegrafFactory({
      cacheProvider: () => new EmptyCache(),
      env,
    });

    const moduleRef = await Test.createTestingModule({
      imports: [LoggerStubModule, TelegrafModule.forRoot(handle.moduleOptions)],
    }).compile();
    try {
      const writer = moduleRef.get(TelegrafConfigWriterService);
      const runtime = moduleRef.get(TelegrafRuntimeService);
      expect(writer).toBeInstanceOf(TelegrafConfigWriterService);
      expect(runtime).toBeInstanceOf(TelegrafRuntimeService);
    } finally {
      await moduleRef.close();
    }
  });

  it('installPartitioner side effect registers the partitioner singleton via partitioning module', async () => {
    clearPartitionerSingleton();
    const handle = buildTelegrafFactory({
      cacheProvider: () => new EmptyCache(),
      env: { TELEGRAF_OWNED_CONF_PATH: join(tmpDir, 'owned.conf') },
    });

    const before = getPartitioner();

    handle.moduleOptions.installPartitioner?.(handle.moduleOptions.partitioner);

    const after = getPartitioner();
    expect(after).not.toBe(before);
    expect(typeof after?.owns).toBe('function');
  });

  it(
    'telegrafEnabled=true wires TelegrafModule lifecycle hooks, writes config file, shuts down cleanly',
    { timeout: 15_000 },
    async () => {
      const outputPath = join(tmpDir, 'owned.conf');
      const env = {
        TELEGRAF_ENABLED: 'true',
        TELEGRAF_OWNED_CONF_PATH: outputPath,
        TELEGRAF_WRITER_DEBOUNCE: '0.0',
        TELEGRAF_WRITER_POLL_INTERVAL: '0.05',
      };
      const handle = buildTelegrafFactory({
        cacheProvider: () => new EmptyCache(),
        env,
      });
      expect(handle.telegrafEnabled).toBe(true);
      expect(getTelegrafConfig(env).outputPath).toBe(outputPath);

      const moduleRef = await Test.createTestingModule({
        imports: [LoggerStubModule, TelegrafModule.forRoot(handle.moduleOptions)],
      }).compile();
      moduleRef.enableShutdownHooks();
      await moduleRef.init();

      try {
        const deadline = Date.now() + 5_000;
        let exists = false;
        while (Date.now() < deadline) {
          try {
            const body = readFileSync(outputPath, 'utf8');
            if (typeof body === 'string') {
              exists = true;
              break;
            }
          } catch (error) {
            void error;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(exists).toBe(true);
      } finally {
        await moduleRef.close();
      }
    },
  );
});
