// Must run before the AppModule import: TelegrafModule.forRoot(...) executes at @Module decorator time, so main.ts calls this right after env-preboot.
// Python parity: bridge/main.py gates run_telegraf_runtime on telegraf_enabled.

import { getLeaderService } from '../leader-election/leader-election.service.js';
import { buildMonitoringConfig } from '../monitoring/monitoring.config.js';

import { getBmcSecretSourceOrThrow } from './bmc-secret-source-holder.js';
import { getTelegrafCacheOrThrow } from './telegraf-cache-holder.js';
import { configureTelegrafFactory } from './telegraf-singleton.js';

function orchestratorEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env.BRIDGE_ORCHESTRATOR_ENABLED ?? '').trim().toLowerCase() === 'true';
}

export function configureTelegrafForBridge(env: NodeJS.ProcessEnv = process.env): void {
  const { telegrafEnabled } = buildMonitoringConfig(env);
  if (!telegrafEnabled || !orchestratorEnabled(env)) return;

  configureTelegrafFactory({
    env,
    cacheProvider: getTelegrafCacheOrThrow,
    secretSourceProvider: getBmcSecretSourceOrThrow,
    leaderServiceProvider: getLeaderService,
  });
}
