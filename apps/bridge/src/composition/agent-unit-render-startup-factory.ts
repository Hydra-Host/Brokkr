import {
  AgentUnitRenderStartupService,
  type AgentUnitRenderStartupLogger,
} from '../brokkr-live/agent-unit-render-startup.service.js';
import type { AgentUnitRenderStartupBlockingDeps } from '../startup/startup-services.js';

export interface AgentUnitRenderStartupFactoryOptions {
  env?: NodeJS.ProcessEnv;
  logger?: AgentUnitRenderStartupLogger;
}

export function buildAgentUnitRenderStartupFactory(
  options: AgentUnitRenderStartupFactoryOptions = {},
): AgentUnitRenderStartupBlockingDeps {
  const { env = process.env, logger } = options;
  const service = new AgentUnitRenderStartupService(logger, undefined, env);
  return {
    renderAgentUnitAtStartup: (jobId: string) => service.renderAgentUnitAtStartup(jobId),
  };
}
