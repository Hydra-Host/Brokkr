import { Module, type DynamicModule, type Provider } from '@nestjs/common';

import { ContextLogger, type LoggerLike } from '../../logger/logger.service';

import type { TelegrafConfigWriterConfig } from './telegraf-config-writer.service';
import { TelegrafConfigWriterService } from './telegraf-config-writer.service';
import type {
  ActiveDevicesPort,
  BmcCredentialsLookupPort,
  BridgePartitionerPort,
  InfraTargetsPort,
  PduVendorClassifierPort,
  TelegrafConfigWriterLogger,
} from './telegraf-config-writer.types';
import {
  TELEGRAF_CONFIG_WRITER,
  TELEGRAF_CREDS_LOOKUP,
  TELEGRAF_PARTITIONER,
  TELEGRAF_PARTITIONER_INSTALLER,
  TELEGRAF_RUNTIME_CONFIG,
  TELEGRAF_RUNTIME_JOB_ID,
  TELEGRAF_RUNTIME_LOGGER,
  TelegrafRuntimeService,
  type TelegrafBmcCredentialsLookupLike,
  type TelegrafConfigWriterLike,
  type TelegrafPartitionerInstaller,
  type TelegrafPartitionerLike,
  type TelegrafRuntimeConfig,
} from './telegraf-runtime.service';

export const TELEGRAF_BRIDGE_PARTITIONER = Symbol('TELEGRAF_BRIDGE_PARTITIONER');
export const TELEGRAF_BMC_CREDENTIALS_LOOKUP = Symbol('TELEGRAF_BMC_CREDENTIALS_LOOKUP');
export const TELEGRAF_ACTIVE_DEVICES = Symbol('TELEGRAF_ACTIVE_DEVICES');
export const TELEGRAF_INFRA_TARGETS = Symbol('TELEGRAF_INFRA_TARGETS');
export const TELEGRAF_PDU_CLASSIFIER = Symbol('TELEGRAF_PDU_CLASSIFIER');
export const TELEGRAF_WRITER_CONFIG = Symbol('TELEGRAF_WRITER_CONFIG');
export const TELEGRAF_WRITER_LOGGER = Symbol('TELEGRAF_WRITER_LOGGER');
export const TELEGRAF_WRITER_JOB_ID = Symbol('TELEGRAF_WRITER_JOB_ID');

export interface TelegrafModuleOptions {
  partitioner: BridgePartitionerPort & TelegrafPartitionerLike;
  credsLookup: BmcCredentialsLookupPort & TelegrafBmcCredentialsLookupLike;
  activeDevices: ActiveDevicesPort;
  infraTargets: InfraTargetsPort;
  pduClassifier: PduVendorClassifierPort;
  writerConfig: TelegrafConfigWriterConfig;
  runtimeConfig: TelegrafRuntimeConfig;
  writerLogger?: TelegrafConfigWriterLogger;
  runtimeLogger?: LoggerLike;
  jobId?: string;
  installPartitioner?: TelegrafPartitionerInstaller;
}

@Module({})
export class TelegrafModule {
  static forRoot(options: TelegrafModuleOptions): DynamicModule {
    const providers: Provider[] = [
      { provide: TELEGRAF_BRIDGE_PARTITIONER, useValue: options.partitioner },
      { provide: TELEGRAF_BMC_CREDENTIALS_LOOKUP, useValue: options.credsLookup },
      { provide: TELEGRAF_ACTIVE_DEVICES, useValue: options.activeDevices },
      { provide: TELEGRAF_INFRA_TARGETS, useValue: options.infraTargets },
      { provide: TELEGRAF_PDU_CLASSIFIER, useValue: options.pduClassifier },
      { provide: TELEGRAF_WRITER_CONFIG, useValue: options.writerConfig },
      {
        provide: TELEGRAF_WRITER_LOGGER,
        useFactory: (defaultLogger: ContextLogger) => options.writerLogger ?? defaultLogger,
        inject: [ContextLogger],
      },
      { provide: TELEGRAF_WRITER_JOB_ID, useValue: options.jobId ?? '' },
      { provide: TELEGRAF_PARTITIONER, useValue: options.partitioner },
      { provide: TELEGRAF_CREDS_LOOKUP, useValue: options.credsLookup },
      { provide: TELEGRAF_RUNTIME_CONFIG, useValue: options.runtimeConfig },
      { provide: TELEGRAF_RUNTIME_JOB_ID, useValue: options.jobId ?? '' },
      { provide: TELEGRAF_RUNTIME_LOGGER, useValue: options.runtimeLogger ?? null },
      {
        provide: TELEGRAF_PARTITIONER_INSTALLER,
        useValue: options.installPartitioner ?? null,
      },
      {
        provide: TelegrafConfigWriterService,
        useFactory: (
          partitioner: BridgePartitionerPort,
          credsLookup: BmcCredentialsLookupPort,
          activeDevices: ActiveDevicesPort,
          infraTargets: InfraTargetsPort,
          pduClassifier: PduVendorClassifierPort,
          config: TelegrafConfigWriterConfig,
          logger: TelegrafConfigWriterLogger,
          jobId: string,
        ): TelegrafConfigWriterService =>
          new TelegrafConfigWriterService(
            partitioner,
            credsLookup,
            activeDevices,
            infraTargets,
            pduClassifier,
            config,
            logger,
            jobId,
          ),
        inject: [
          TELEGRAF_BRIDGE_PARTITIONER,
          TELEGRAF_BMC_CREDENTIALS_LOOKUP,
          TELEGRAF_ACTIVE_DEVICES,
          TELEGRAF_INFRA_TARGETS,
          TELEGRAF_PDU_CLASSIFIER,
          TELEGRAF_WRITER_CONFIG,
          TELEGRAF_WRITER_LOGGER,
          TELEGRAF_WRITER_JOB_ID,
        ],
      },
      {
        provide: TELEGRAF_CONFIG_WRITER,
        useExisting: TelegrafConfigWriterService,
      },
      TelegrafRuntimeService,
    ];

    return {
      module: TelegrafModule,
      providers,
      exports: [TelegrafConfigWriterService, TelegrafRuntimeService, TELEGRAF_CONFIG_WRITER],
    };
  }
}

export type {
  ActiveDevicesPort,
  BmcCredentialsLookupPort,
  BridgePartitionerPort,
  InfraTargetsPort,
  PduVendorClassifierPort,
  TelegrafBmcCredentialsLookupLike,
  TelegrafConfigWriterConfig,
  TelegrafConfigWriterLike,
  TelegrafConfigWriterLogger,
  TelegrafPartitionerInstaller,
  TelegrafPartitionerLike,
  TelegrafRuntimeConfig,
};

export {
  TELEGRAF_CONFIG_WRITER,
  TELEGRAF_CREDS_LOOKUP,
  TELEGRAF_PARTITIONER,
  TELEGRAF_PARTITIONER_INSTALLER,
  TELEGRAF_RUNTIME_CONFIG,
  TELEGRAF_RUNTIME_JOB_ID,
  TELEGRAF_RUNTIME_LOGGER,
};
