import { operations } from '@repo/bridge-agent-protocol';

import type { AgentConfig } from '../config';
import { getHandler } from '../dispatch/registry';
import { registerCoreOperations } from '../operations/index';
import { AGENT_VERSION } from '../version';

export async function runCollectCli(config: AgentConfig, collectorFilter: string[]): Promise<number> {
  registerCoreOperations({
    agentVersion: AGENT_VERSION,
    collectionSnapshotDir: config.agent.collection_snapshot_path,
  });

  const reg = getHandler('collection.collectAll');
  if (!reg) {
    process.stderr.write('collection.collectAll not registered\n');
    return 2;
  }

  const controller = new AbortController();
  const ctx = {
    work_id: 'cli',
    job_id: 'cli',
    signal: controller.signal,
    reportProgress: () => {},
    emit: async () => {},
    resultDelivered: Promise.resolve(),
  };

  const input = collectorFilter.length > 0 ? { collectors: collectorFilter } : {};

  try {
    const result = await reg.handler(input, ctx);
    const parsed = operations['collection.collectAll'].output.safeParse(result);
    if (!parsed.success) {
      process.stderr.write(`collectAll returned invalid output: ${JSON.stringify(parsed.error.format(), null, 2)}\n`);
      return 2;
    }
    const summary = parsed.data;
    process.stdout.write(
      `\ncollection complete: ${summary.successes} ok / ${summary.failures} failed in ${summary.total_duration_ms}ms\n`,
    );
    process.stdout.write(`snapshots at ${config.agent.collection_snapshot_path}/:\n`);
    for (const name of summary.collectors_run) {
      process.stdout.write(`  ${name}.json\n`);
    }
    return summary.failures > 0 ? 1 : 0;
  } catch (err) {
    process.stderr.write(`collection failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
