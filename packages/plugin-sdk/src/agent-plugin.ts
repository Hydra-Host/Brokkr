import type { z } from 'zod';

export interface AgentOperationContext {
  work_id: string;
  job_id?: string | undefined;
  signal: AbortSignal;
  reportProgress: (progress: number, message?: string) => void;
}

export type AgentOperationHandler<I extends z.ZodType, O extends z.ZodType> = (
  input: z.infer<I>,
  ctx: AgentOperationContext,
) => Promise<z.infer<O>> | z.infer<O>;

export interface AgentPluginContext {
  registerOperation<I extends z.ZodType, O extends z.ZodType>(
    name: string,
    input: I,
    output: O,
    handler: AgentOperationHandler<I, O>,
  ): void;
}

export interface AgentPlugin {
  id: string;
  setup(ctx: AgentPluginContext): void | Promise<void>;
}

export function defineAgentPlugin(plugin: AgentPlugin): AgentPlugin {
  return plugin;
}

export interface AgentPluginConfigEntry {
  plugin: AgentPlugin;
  enabled: boolean;
}

export function defineAgentPluginsConfig(
  entries: readonly AgentPluginConfigEntry[],
): readonly AgentPluginConfigEntry[] {
  return entries;
}
