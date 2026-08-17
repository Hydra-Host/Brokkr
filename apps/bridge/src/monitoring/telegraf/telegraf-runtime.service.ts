import { Inject, Injectable, Optional, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';

import { getErrorMessage } from '../../common/error-utils';
import type { LoggerLike } from '../../logger/logger.service';

export const TELEGRAF_PARTITIONER = Symbol('TELEGRAF_PARTITIONER');
export const TELEGRAF_CONFIG_WRITER = Symbol('TELEGRAF_CONFIG_WRITER');
export const TELEGRAF_CREDS_LOOKUP = Symbol('TELEGRAF_CREDS_LOOKUP');
export const TELEGRAF_RUNTIME_CONFIG = Symbol('TELEGRAF_RUNTIME_CONFIG');
export const TELEGRAF_RUNTIME_JOB_ID = Symbol('TELEGRAF_RUNTIME_JOB_ID');
export const TELEGRAF_RUNTIME_LOGGER = Symbol('TELEGRAF_RUNTIME_LOGGER');
export const TELEGRAF_PARTITIONER_INSTALLER = Symbol('TELEGRAF_PARTITIONER_INSTALLER');

const APP_CLASS_NAME = 'telegraf-runtime';

export interface TelegrafPartitionerLike {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface TelegrafConfigWriterLike {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface TelegrafBmcCredentialsLookupLike {
  close?(): Promise<void>;
}

export interface TelegrafRenderConfigInput {
  bridgeApiUrl: string;
  pollInterval: string;
  timeout: string;
}

export interface TelegrafRuntimeConfig {
  outputPath: string;
  renderConfig: TelegrafRenderConfigInput;
  debounceSeconds: number;
  pollIntervalSeconds: number;
}

export type TelegrafPartitionerInstaller = (p: TelegrafPartitionerLike | null) => void;

@Injectable()
export class TelegrafRuntimeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly partitioner: TelegrafPartitionerLike;
  private readonly writer: TelegrafConfigWriterLike;
  private readonly credsLookup: TelegrafBmcCredentialsLookupLike;
  private readonly config: TelegrafRuntimeConfig;
  private readonly jobId: string;
  private readonly logger: LoggerLike | null;
  private readonly installPartitioner: TelegrafPartitionerInstaller | null;

  private startPromise: Promise<void> | null = null;
  private lookupClosed = false;
  private installed = false;

  constructor(
    @Inject(TELEGRAF_PARTITIONER) partitioner: TelegrafPartitionerLike,
    @Inject(TELEGRAF_CONFIG_WRITER) writer: TelegrafConfigWriterLike,
    @Inject(TELEGRAF_CREDS_LOOKUP) credsLookup: TelegrafBmcCredentialsLookupLike,
    @Inject(TELEGRAF_RUNTIME_CONFIG) config: TelegrafRuntimeConfig,
    @Optional() @Inject(TELEGRAF_RUNTIME_JOB_ID) jobId?: string,
    @Optional() @Inject(TELEGRAF_RUNTIME_LOGGER) logger?: LoggerLike,
    @Optional() @Inject(TELEGRAF_PARTITIONER_INSTALLER) installPartitioner?: TelegrafPartitionerInstaller,
  ) {
    this.partitioner = partitioner;
    this.writer = writer;
    this.credsLookup = credsLookup;
    this.config = config;
    this.jobId = jobId ?? '';
    this.logger = logger ?? null;
    this.installPartitioner = installPartitioner ?? null;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.startPromise !== null) return;
    this.startPromise = this.runUntilExit();
    this.startPromise.catch((error: unknown) => {
      void this.logger?.error(`telegraf runtime startup failed: ${getErrorMessage(error)}`, {
        appClassName: APP_CLASS_NAME,
        jobId: this.jobId,
      });
    });
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await Promise.allSettled([this.writer.stop(), this.partitioner.stop()]);
    } finally {
      await this.closeLookup();
    }
    if (this.startPromise !== null) {
      try {
        await this.startPromise;
      } catch (error) {
        void this.logger?.debug(`telegraf runtime exit error during shutdown: ${getErrorMessage(error)}`, {
          appClassName: APP_CLASS_NAME,
          jobId: this.jobId,
        });
      }
    }
  }

  private async runUntilExit(): Promise<void> {
    if (!this.installed) {
      this.installed = true;
      if (this.installPartitioner !== null) {
        this.installPartitioner(this.partitioner);
      }
    }
    await this.logger?.info(`telegraf runtime starting; output=${String(this.config.outputPath)}`, {
      appClassName: APP_CLASS_NAME,
      jobId: this.jobId,
    });
    const partitionerStart = Promise.resolve().then(() => this.partitioner.start());
    const writerStart = Promise.resolve().then(() => this.writer.start());
    try {
      await gatherAsyncio([partitionerStart, writerStart]);
    } finally {
      await this.closeLookup();
    }
  }

  private async closeLookup(): Promise<void> {
    if (this.lookupClosed) return;
    this.lookupClosed = true;
    if (typeof this.credsLookup.close === 'function') {
      await this.credsLookup.close();
    }
  }
}

export async function gatherAsyncio<T>(promises: ReadonlyArray<Promise<T>>): Promise<T[]> {
  if (promises.length === 0) return [];
  for (const p of promises) {
    p.catch(() => undefined);
  }
  const firstRejection = new Promise<never>((_, reject) => {
    for (const p of promises) {
      p.then(
        () => undefined,
        (err: unknown) => reject(err),
      );
    }
  });
  return await Promise.race([Promise.all(promises), firstRejection]);
}

export function readTelegrafRuntimeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TelegrafRuntimeConfig {
  return {
    outputPath: env.TELEGRAF_OWNED_CONF_PATH ?? '/local/telegraf.d/owned.conf',
    renderConfig: {
      bridgeApiUrl: env.BRIDGE_API_URL ?? 'http://127.0.0.1:80',
      pollInterval: env.TELEGRAF_POLL_INTERVAL ?? '30s',
      timeout: env.TELEGRAF_HTTP_TIMEOUT ?? '10s',
    },
    debounceSeconds: parseStrictFloat('TELEGRAF_WRITER_DEBOUNCE', env.TELEGRAF_WRITER_DEBOUNCE ?? '30.0'),
    pollIntervalSeconds: parseStrictFloat('TELEGRAF_WRITER_POLL_INTERVAL', env.TELEGRAF_WRITER_POLL_INTERVAL ?? '10.0'),
  };
}

function parseStrictFloat(name: string, value: string): number {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error(`could not convert string to float: '${value}' (env=${name})`);
  }
  const specialMatch = /^([+-]?)(inf(inity)?|nan)$/i.exec(trimmed);
  if (specialMatch !== null) {
    const sign = specialMatch[1] === '-' ? -1 : 1;
    return /^nan$/i.test(specialMatch[2]!) ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  }
  const numericPattern = /^[+-]?(\d(_?\d)*(\.(\d(_?\d)*)?)?|\.\d(_?\d)*)([eE][+-]?\d(_?\d)*)?$/;
  if (!numericPattern.test(trimmed)) {
    throw new Error(`could not convert string to float: '${value}' (env=${name})`);
  }
  const parsed = Number(trimmed.replace(/_/g, ''));
  if (Number.isNaN(parsed)) {
    throw new Error(`could not convert string to float: '${value}' (env=${name})`);
  }
  return parsed;
}
