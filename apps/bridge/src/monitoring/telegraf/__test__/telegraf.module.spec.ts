import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { ContextLogger } from '../../../logger/logger.service';
import type { TelegrafConfigWriterConfig } from '../telegraf-config-writer.service';
import { TelegrafConfigWriterService } from '../telegraf-config-writer.service';
import type {
  ActiveDevicesPort,
  BmcCredentialsLookupPort,
  BridgePartitionerPort,
  InfraTargetsPort,
  PduVendorClassifierPort,
} from '../telegraf-config-writer.types';
import {
  TELEGRAF_CONFIG_WRITER,
  TelegrafRuntimeService,
  type TelegrafBmcCredentialsLookupLike,
  type TelegrafPartitionerLike,
  type TelegrafRuntimeConfig,
} from '../telegraf-runtime.service';
import { TelegrafModule, type TelegrafModuleOptions } from '../telegraf.module';

@Global()
@Module({
  providers: [{ provide: ContextLogger, useValue: new ContextLogger() }],
  exports: [ContextLogger],
})
class LoggerStubModule {}

function stubOptions(): TelegrafModuleOptions {
  const partitioner: BridgePartitionerPort & TelegrafPartitionerLike = {
    owns: () => true,
    start: async () => {},
    stop: async () => {},
  };
  const credsLookup: BmcCredentialsLookupPort & TelegrafBmcCredentialsLookupLike = {
    get: async () => null,
    close: async () => {},
  };
  const activeDevices: ActiveDevicesPort = {
    iterActiveDeviceIds: async function* () {},
    getCachedDeviceData: async () => null,
  };
  const infraTargets: InfraTargetsPort = {
    extractRole: () => null,
    classifyRole: () => 'server',
  };
  const pduClassifier: PduVendorClassifierPort = {
    classifyPduVendor: () => null,
  };
  const writerConfig: TelegrafConfigWriterConfig = {
    outputPath: '/tmp/telegraf-test.conf',
    renderConfig: {
      bridge_api_url: 'http://127.0.0.1:80',
      poll_interval: '30s',
      timeout: '10s',
    },
  };
  const runtimeConfig: TelegrafRuntimeConfig = {
    outputPath: '/tmp/telegraf-test.conf',
    renderConfig: {
      bridgeApiUrl: 'http://127.0.0.1:80',
      pollInterval: '30s',
      timeout: '10s',
    },
    debounceSeconds: 30,
    pollIntervalSeconds: 10,
  };
  return {
    partitioner,
    credsLookup,
    activeDevices,
    infraTargets,
    pduClassifier,
    writerConfig,
    runtimeConfig,
  };
}

describe('TelegrafModule.forRoot', () => {
  it('resolves TelegrafConfigWriterService when port adapters are supplied', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerStubModule, TelegrafModule.forRoot(stubOptions())],
    }).compile();
    try {
      const writer = moduleRef.get(TelegrafConfigWriterService);
      expect(writer).toBeInstanceOf(TelegrafConfigWriterService);
    } finally {
      await moduleRef.close();
    }
  });

  it('resolves TelegrafRuntimeService and aliases TELEGRAF_CONFIG_WRITER to the writer instance', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [LoggerStubModule, TelegrafModule.forRoot(stubOptions())],
    }).compile();
    try {
      const writer = moduleRef.get(TelegrafConfigWriterService);
      const runtime = moduleRef.get(TelegrafRuntimeService);
      const aliased = moduleRef.get(TELEGRAF_CONFIG_WRITER);
      expect(runtime).toBeInstanceOf(TelegrafRuntimeService);
      expect(aliased).toBe(writer);
    } finally {
      await moduleRef.close();
    }
  });
});
