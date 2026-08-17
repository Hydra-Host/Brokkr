// The host awaits gates in priority order BEFORE the irreversible action; handlers must be idempotent (the host may retry a passed gate) and take no irreversible side effects. Declare gates by augmenting `BrokkrGateMap`.

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface BrokkrGateMap {}

export type BrokkrGateName = keyof BrokkrGateMap & string;

export type BrokkrGateHandler<G extends BrokkrGateName> = (payload: BrokkrGateMap[G]) => void | Promise<void>;

export const PLUGIN_GATE_BUS = Symbol.for('@hydrahost/plugin-sdk/PLUGIN_GATE_BUS');

export class LifecycleGateRejection extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'LifecycleGateRejection';
  }
}

/** Park (not veto): the host suspends the job in `DEFERRED` until the plugin calls `resumeDeferred`/`abortDeferred`; a deliberate policy outcome — never trips the circuit breaker. */
export class LifecycleGateDeferral extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'LifecycleGateDeferral';
  }
}

export class GateRegistrationDeniedError extends Error {
  constructor(
    public readonly pluginId: string,
    public readonly gate: BrokkrGateName,
  ) {
    super(`Plugin "${pluginId}" is not authorized to register for gate "${gate}"`);
    this.name = 'GateRegistrationDeniedError';
  }
}

export interface GateRegisterOptions {
  priority?: number;
}

export interface PluginGateBus {
  register<G extends BrokkrGateName>(gate: G, handler: BrokkrGateHandler<G>, opts?: GateRegisterOptions): () => void;
}
