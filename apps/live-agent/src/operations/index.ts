import { registerAgentOperations } from './agent/index';
import { registerBenchmarkOperations } from './benchmark/index';
import { registerCollectionOperations } from './collection/index';
import { registerDeployOperations } from './deploy/index';
import { registerDiagnosticOperations } from './diagnostic/index';
import { registerStorageOperations } from './storage/index';
import { registerSystemOperations } from './system';
import { registerTestOperations } from './test/index';

export function registerCoreOperations(options: { agentVersion: string; collectionSnapshotDir: string }): void {
  registerAgentOperations();
  registerSystemOperations();
  registerCollectionOperations(options.agentVersion, options.collectionSnapshotDir);
  registerStorageOperations();
  registerDeployOperations();
  registerBenchmarkOperations();
  registerTestOperations();
  registerDiagnosticOperations();
}
