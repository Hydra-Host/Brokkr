import { isRecord } from '@repo/utils';

import { jsonFlag } from '../saga-framework/dispatch-payload';

import { RedfishDevice } from '../redfish/index.js';
import type { TeeVerificationResult } from '../redfish/vendor/base/tee.js';

function notWired(name: string): never {
  throw new Error(`${name} not wired — RedfishService requires explicit handler-factory injection.`);
}

function tsTypeName(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'Array';
  return typeof value;
}

export type RedfishCommandKwargs = Record<string, unknown>;

export interface BootHandlerLike {
  discover(): Promise<void>;
  reliableBoot(): Promise<void>;
}

export interface DiscoveryHandlerLike {
  device: { biosParams: Record<string, unknown>; biosPendingParams: Record<string, unknown> };
  discover(): Promise<void>;
}

export interface TeeHandlerLike {
  discover(): Promise<void>;
  setTee(newSetting?: boolean): Promise<boolean>;
  verifyTee(): Promise<TeeVerificationResult>;
}

export interface RedfishServiceOptions {
  bootHandlerFactory?: (device: RedfishDevice, jobId: string) => BootHandlerLike;
  discoveryHandlerFactory?: (device: RedfishDevice, jobId: string) => DiscoveryHandlerLike;
  teeHandlerFactory?: (device: RedfishDevice, jobId: string) => TeeHandlerLike;
}

export class RedfishService {
  readonly jobId: string;
  readonly availableCommands: readonly string[] = ['bios_attributes', 'reliable_boot', 'set_tee', 'verify_tee'];
  private readonly bootHandlerFactory: (device: RedfishDevice, jobId: string) => BootHandlerLike;
  private readonly discoveryHandlerFactory: (device: RedfishDevice, jobId: string) => DiscoveryHandlerLike;
  private readonly teeHandlerFactory: (device: RedfishDevice, jobId: string) => TeeHandlerLike;

  constructor(jobId = '', options: RedfishServiceOptions = {}) {
    this.jobId = jobId;
    this.bootHandlerFactory = options.bootHandlerFactory ?? (() => notWired('bootHandlerFactory'));
    this.discoveryHandlerFactory = options.discoveryHandlerFactory ?? (() => notWired('discoveryHandlerFactory'));
    this.teeHandlerFactory = options.teeHandlerFactory ?? (() => notWired('teeHandlerFactory'));
  }

  hasCommand(command: string): boolean {
    return this.availableCommands.includes(command);
  }

  async execute(
    command: string,
    device: RedfishDevice,
    kwargs: RedfishCommandKwargs = {},
  ): Promise<Record<string, unknown>> {
    if (command === 'reliable_boot') return this.reliableBoot(device, kwargs);
    if (command === 'bios_attributes') return this.biosAttributes(device, kwargs);
    if (command === 'set_tee') return this.setTee(device, kwargs);
    if (command === 'verify_tee') return this.verifyTee(device, kwargs);
    throw new Error(`Unknown Redfish command: ${command}`);
  }

  async reliableBoot(device: RedfishDevice, _kwargs: RedfishCommandKwargs = {}): Promise<Record<string, unknown>> {
    const handler = this.bootHandlerFactory(device, this.jobId);
    await handler.discover();
    await handler.reliableBoot();
    return { success: true };
  }

  async biosAttributes(device: RedfishDevice, kwargs: RedfishCommandKwargs = {}): Promise<Record<string, unknown>> {
    const handler = this.discoveryHandlerFactory(device, this.jobId);
    await handler.discover();
    const payload = 'payload' in kwargs ? kwargs['payload'] : {};
    if (payload === null || payload === undefined) {
      throw new TypeError(`Cannot read properties of ${payload === null ? 'null' : 'undefined'} (reading 'get')`);
    }
    if (!isRecord(payload)) {
      throw new TypeError(`Expected object for payload, got ${tsTypeName(payload)}`);
    }
    const pending = jsonFlag('pending' in payload ? payload['pending'] : false);
    if (pending) {
      return { bios_attributes: handler.device.biosPendingParams };
    }
    return { bios_attributes: handler.device.biosParams };
  }

  async setTee(device: RedfishDevice, kwargs: RedfishCommandKwargs = {}): Promise<Record<string, unknown>> {
    const handler = this.teeHandlerFactory(device, this.jobId);
    // Unexpected-keyword TypeError must fire AFTER discover(), so its side effects are committed.
    await handler.discover();
    const allowedKeys = new Set(['new_setting']);
    for (const key of Object.keys(kwargs)) {
      if (!allowedKeys.has(key)) {
        throw new TypeError(`set_tee() got an unexpected keyword argument '${key}'`);
      }
    }
    const hasNewSetting = 'new_setting' in kwargs;
    const teeResult = hasNewSetting ? await handler.setTee(jsonFlag(kwargs['new_setting'])) : await handler.setTee();
    return { success: teeResult };
  }

  async verifyTee(device: RedfishDevice, _kwargs: RedfishCommandKwargs = {}): Promise<TeeVerificationResult> {
    const handler = this.teeHandlerFactory(device, this.jobId);
    await handler.discover();
    return handler.verifyTee();
  }
}

export function createRedfishService(jobId = '', options: RedfishServiceOptions = {}): RedfishService {
  return new RedfishService(jobId, options);
}
