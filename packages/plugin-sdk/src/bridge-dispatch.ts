export const BRIDGE_AGENT_DISPATCH = Symbol.for('@hydrahost/plugin-sdk/BRIDGE_AGENT_DISPATCH');

export interface BridgeAgentDispatchOptions {
  timeoutS?: number;
  signal?: AbortSignal;
}

export interface BridgeAgentDispatch {
  dispatch(deviceId: string, operation: string, input: unknown, options?: BridgeAgentDispatchOptions): Promise<unknown>;
}
