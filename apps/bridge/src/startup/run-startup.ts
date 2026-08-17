import { StartupOrchestrator } from './orchestrator.js';
import type { StartupLogger } from './startup-deps.types.js';
import type { BuildStartupOrchestratorArgs } from './startup-services.js';
import { registerStartupTasks } from './startup-services.js';

export interface RunStartupArgs extends Omit<BuildStartupOrchestratorArgs, 'orchestrator'> {
  logger: StartupLogger;
}

export async function runStartup(jobId: string, args: RunStartupArgs): Promise<StartupOrchestrator> {
  const orchestrator = new StartupOrchestrator(args.logger);
  registerStartupTasks(jobId, { ...args, orchestrator });

  args.logger.info('Phase 1: Running startup tasks', { jobId });
  await orchestrator.runBlockingTasks(jobId);

  args.logger.info('Phase 2: Starting background tasks', { jobId });
  await orchestrator.startBackgroundServices(jobId);

  return orchestrator;
}
