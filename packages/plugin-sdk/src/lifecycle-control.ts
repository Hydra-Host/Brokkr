export const PLUGIN_LIFECYCLE = Symbol.for('@hydrahost/plugin-sdk/PLUGIN_LIFECYCLE');

export interface PluginLifecycleControl {
  resumeDeferred(jobId: string): Promise<boolean>;

  abortDeferred(jobId: string, reason: string): Promise<boolean>;
}
