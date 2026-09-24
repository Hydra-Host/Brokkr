export const PLUGIN_LIFECYCLE = Symbol.for('@hydrahost/plugin-sdk/PLUGIN_LIFECYCLE');

/** Stable machine cause for operator-hub approval rejection (not a provision failure). */
export const DEFERRED_ABORT_CAUSE_OPERATOR_APPROVAL_REJECTED = 'operator_approval_rejected' as const;

export type DeferredAbortCause = typeof DEFERRED_ABORT_CAUSE_OPERATOR_APPROVAL_REJECTED;

export interface AbortDeferredOptions {
  cause?: DeferredAbortCause;
}

export interface PluginLifecycleControl {
  resumeDeferred(jobId: string): Promise<boolean>;

  abortDeferred(jobId: string, reason: string, options?: AbortDeferredOptions): Promise<boolean>;
}
