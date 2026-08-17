import { Inject, Injectable } from '@nestjs/common';
import { getErrorMessage } from '../common/error-utils';

import type { OperationName, OperationOutput } from '@repo/bridge-agent-protocol';

import { ContextLogger } from '../logger/logger.service';

export interface EfiBootServiceLogger {
  debug(message: string, context?: { jobId?: string }): Promise<void>;
  info(message: string, context?: { jobId?: string }): Promise<void>;
  warning(message: string, context?: { jobId?: string }): Promise<void>;
  error(message: string, context?: { jobId?: string }): Promise<void>;
}

export type EfiBootDispatchFn = <N extends OperationName>(
  deviceId: string,
  operation: N,
  input: unknown,
  options?: { jobId?: string; timeoutS?: number; signal?: AbortSignal; workId?: string },
) => Promise<OperationOutput<N>>;

export class EfiBootServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EfiBootServiceError';
  }
}

export const OS_BOOT_ENTRY_KEYWORDS: readonly string[] = ['ubuntu', 'debian', 'proxmox', 'ipxe disk'];

export interface EfiBootMenuResult {
  boot_current: unknown;
  boot_order: unknown;
  boot_options: unknown;
  boot_next: unknown;
}

export interface EfiBootCleanupResult extends Record<string, unknown> {
  removed: unknown;
  count: number;
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

function formatRemoved(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export class EfiBootService {
  bootCurrent: unknown = null;
  bootOrder: unknown = null;
  bootOptions: unknown = null;
  bootNext: unknown = null;
  private dispatchIndex = 0;

  constructor(
    public readonly jobId: string,
    public readonly deviceId: string,
    private readonly dispatch: EfiBootDispatchFn,
    private readonly logger: EfiBootServiceLogger,
    private readonly signal?: AbortSignal,
    private readonly workId?: string,
  ) {}

  private dispatchOptions(timeoutS: number): {
    jobId: string;
    timeoutS: number;
    signal?: AbortSignal;
    workId?: string;
  } {
    return {
      jobId: this.jobId,
      timeoutS,
      signal: this.signal,
      workId: this.workId === undefined ? undefined : `${this.workId}:${this.dispatchIndex++}`,
    };
  }

  async getBootMenu(): Promise<EfiBootMenuResult> {
    await this.logger.debug(`Starting EFI boot menu retrieval for job ${this.jobId}`, {
      jobId: this.jobId,
    });

    try {
      await this.logger.info('Retrieving EFI boot menu information', { jobId: this.jobId });

      const response = await this.dispatch(this.deviceId, 'system.getEfiBootMenu', {}, this.dispatchOptions(30));

      this.bootCurrent = response.boot_current ?? null;
      this.bootOrder = response.boot_order ?? null;
      this.bootOptions = response.boot_options ?? null;
      this.bootNext = response.boot_next ?? null;

      await this.logger.info(
        `Boot menu retrieved - Current: ${String(this.bootCurrent)}, Order: ${String(this.bootOrder)}`,
        { jobId: this.jobId },
      );

      return {
        boot_current: this.bootCurrent,
        boot_order: this.bootOrder,
        boot_options: this.bootOptions,
        boot_next: this.bootNext,
      };
    } catch (error) {
      if (error instanceof EfiBootServiceError) throw error;
      const message = getErrorMessage(error);
      await this.logger.error(`Failed to get EFI boot menu: ${message}`, { jobId: this.jobId });
      throw new EfiBootServiceError(`Failed to get EFI boot menu: ${message}`);
    }
  }

  async removeBootEntry(bootId: string): Promise<boolean> {
    await this.logger.debug(`Starting removal of boot entry ${bootId}`, { jobId: this.jobId });

    try {
      await this.logger.info(`Removing boot entry: ${bootId}`, { jobId: this.jobId });
      const response = await this.dispatch(
        this.deviceId,
        'system.removeEfiBootEntry',
        { boot_id: bootId },
        this.dispatchOptions(30),
      );
      const success = response.success;
      if (success) {
        await this.logger.info(`Successfully removed boot entry: ${bootId}`, {
          jobId: this.jobId,
        });
      }
      return success;
    } catch (error) {
      await this.logger.error(`Failed to remove boot entry ${bootId}: ${getErrorMessage(error)}`, {
        jobId: this.jobId,
      });
      return false;
    }
  }

  async forceBootDevice(): Promise<void> {
    await this.logger.debug('Starting force boot device operation', { jobId: this.jobId });

    try {
      await this.logger.info('Starting force boot device operation', { jobId: this.jobId });

      const response = await this.dispatch(this.deviceId, 'system.forceBootDevice', {}, this.dispatchOptions(60));

      this.bootCurrent = response.boot_current;
      this.bootOrder = response.boot_order;
      const entriesRemoved = response.entries_removed;

      if (!hasValue(this.bootCurrent) || !hasValue(this.bootOrder)) {
        await this.logger.warning('Missing boot current or boot order information', {
          jobId: this.jobId,
        });
      }

      await this.logger.info(`Removed ${entriesRemoved} boot entries`, { jobId: this.jobId });
      await this.logger.info('Force boot device operation completed', { jobId: this.jobId });
    } catch (error) {
      const message = getErrorMessage(error);
      await this.logger.error(`Force boot device operation failed: ${message}`, {
        jobId: this.jobId,
      });
      throw new EfiBootServiceError(`Force boot device failed: ${message}`);
    }
  }

  async cleanupOsBootEntries(): Promise<EfiBootCleanupResult> {
    await this.logger.info('Cleaning up OS boot entries', { jobId: this.jobId });

    try {
      const response = await this.dispatch(this.deviceId, 'system.cleanupOsBootEntries', {}, this.dispatchOptions(60));

      const removed = response.removed;
      const count = response.count;

      if (removed.length > 0) {
        await this.logger.info(`Removed ${count} OS boot entries: ${formatRemoved(removed)}`, { jobId: this.jobId });
      } else {
        await this.logger.info('No OS boot entries found to remove', { jobId: this.jobId });
      }

      return { removed, count };
    } catch (error) {
      const message = getErrorMessage(error);
      await this.logger.error(`cleanup_os_boot_entries failed: ${message}`, {
        jobId: this.jobId,
      });
      throw new EfiBootServiceError(`Failed to clean up OS boot entries: ${message}`);
    }
  }
}

export const EFI_BOOT_DISPATCH = Symbol('EFI_BOOT_DISPATCH');
export const EFI_BOOT_LOGGER = Symbol('EFI_BOOT_LOGGER');

export interface EfiBootServiceFactoryCreateArgs {
  jobId: string;
  deviceId: string;
  signal?: AbortSignal;
  workId?: string;
}

@Injectable()
export class EfiBootServiceFactory {
  constructor(
    @Inject(EFI_BOOT_DISPATCH) private readonly dispatch: EfiBootDispatchFn,
    private readonly logger: ContextLogger,
  ) {}

  async create(args: EfiBootServiceFactoryCreateArgs): Promise<EfiBootService> {
    return new EfiBootService(args.jobId, args.deviceId, this.dispatch, this.logger, args.signal, args.workId);
  }
}

export const EFI_BOOT_SERVICE_FACTORY = Symbol('EFI_BOOT_SERVICE_FACTORY');
