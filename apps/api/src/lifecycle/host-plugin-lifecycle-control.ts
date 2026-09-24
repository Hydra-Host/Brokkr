import type { AbortDeferredOptions, PluginLifecycleControl } from '@hydrahost/plugin-sdk';
import { Injectable } from '@nestjs/common';

import { LifecycleService } from './lifecycle.service';

@Injectable()
export class HostPluginLifecycleControl implements PluginLifecycleControl {
  constructor(private readonly lifecycle: LifecycleService) {}

  resumeDeferred(jobId: string): Promise<boolean> {
    return this.lifecycle.resumeDeferred(jobId);
  }

  abortDeferred(jobId: string, reason: string, options?: AbortDeferredOptions): Promise<boolean> {
    return this.lifecycle.abortDeferred(jobId, reason, options);
  }
}
