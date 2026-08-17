import { runCollectCli } from './cli/collect';
import { loadConfig } from './config';
import { GrpcConnectionManager } from './connection/grpc-manager';
import { startLockscreen } from './lockscreen/index';
import { makeLogger, setLevel } from './logger';
import { registerCoreOperations } from './operations/index';
import { cancelPhoneHomeRetry } from './phone-home';
import { registerAgentPlugins } from './plugin-host/register-plugins';
import agentPluginsConfig from './plugins.config';
import { initAgentTelemetry, shutdownAgentTelemetry } from './telemetry/init';
import { AGENT_VERSION } from './version';
const logger = makeLogger('startup');

const DEFAULT_CONFIG_PATH = '/opt/brokkr/agent.yaml';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === 'collect') {
    const collectArgs = args.slice(1);
    const configIdx = collectArgs.indexOf('--config');
    let collectConfigPath = DEFAULT_CONFIG_PATH;
    let collectorFilter = collectArgs;
    if (configIdx !== -1) {
      collectConfigPath = collectArgs[configIdx + 1] ?? DEFAULT_CONFIG_PATH;
      collectorFilter = [...collectArgs.slice(0, configIdx), ...collectArgs.slice(configIdx + 2)];
    }
    const config = loadConfig(collectConfigPath);
    setLevel('warn');
    const exitCode = await runCollectCli(config, collectorFilter);
    process.exit(exitCode);
  }

  if (args[0] === 'lockscreen') {
    const ac = new AbortController();
    process.on('SIGTERM', () => ac.abort());
    process.on('SIGINT', () => ac.abort());
    startLockscreen({ signal: ac.signal });
    return;
  }

  const configPath = args[0] ?? DEFAULT_CONFIG_PATH;

  const config = loadConfig(configPath);
  setLevel(config.agent.log_level);

  logger.info('bridge-agent starting', {
    device_id: config.device_id,
    agent_version: AGENT_VERSION,
    bridges: config.bridges.length,
  });

  registerCoreOperations({
    agentVersion: AGENT_VERSION,
    collectionSnapshotDir: config.agent.collection_snapshot_path,
  });

  await registerAgentPlugins(agentPluginsConfig);

  const manager = new GrpcConnectionManager(config);
  initAgentTelemetry({
    enabled: config.telemetry.traces_enabled,
    deviceId: config.device_id,
    zoneId: config.zone_id,
    sender: manager.traceSender,
  });
  manager.start();

  const shutdown = (signal: NodeJS.Signals) => {
    logger.info('shutdown signal received', { signal });
    void shutdownAgentTelemetry().finally(() => {
      manager.stop();
      cancelPhoneHomeRetry();
    });
    // No process.exit() — systemd's TimeoutStopSec owns the grace window; event loop drains naturally.
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('fatal:', error);
  process.exit(1);
});
