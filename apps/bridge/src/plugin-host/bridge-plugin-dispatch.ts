import type { BridgeAgentDispatch, BridgeAgentDispatchOptions } from '@hydrahost/plugin-sdk';

import type { DispatchOptions } from '../agent/dispatch/dispatcher.service.js';

export interface AgentDispatchPort {
  dispatch(deviceId: string, operation: string, input: unknown, options?: DispatchOptions): Promise<unknown>;
}

export class PrefixedBridgeAgentDispatch implements BridgeAgentDispatch {
  constructor(
    private readonly dispatcher: AgentDispatchPort,
    private readonly pluginId: string,
  ) {}

  async dispatch(
    deviceId: string,
    operation: string,
    input: unknown,
    options: BridgeAgentDispatchOptions = {},
  ): Promise<unknown> {
    return this.dispatcher.dispatch(deviceId, `${this.pluginId}.${operation}`, input, {
      timeoutS: options.timeoutS ?? null,
      signal: options.signal,
    });
  }
}
