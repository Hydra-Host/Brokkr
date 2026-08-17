import type { AgentPluginConfigEntry, AgentPluginContext } from '@hydrahost/plugin-sdk';
import type { z } from 'zod';

import { getHandler, registerPluginOperation, type Handler } from '../dispatch/registry';
import { getErrorMessage } from '../errors';
import { makeLogger } from '../logger';

const logger = makeLogger('plugin-host');

const PLUGIN_ID = /^[a-z0-9][a-z0-9_-]*$/;
const LOCAL_OPERATION_NAME = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)*$/;

interface StagedOperation {
  name: string;
  input: z.ZodType;
  output: z.ZodType;
  handler: Handler;
}

function buildContext(pluginId: string, staged: StagedOperation[]): AgentPluginContext {
  return {
    registerOperation(name, input, output, handler) {
      if (!LOCAL_OPERATION_NAME.test(name)) {
        throw new Error(`invalid plugin operation name: '${name}'`);
      }
      staged.push({
        name: `${pluginId}.${name}`,
        input,
        output,
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        handler: handler as Handler,
      });
    },
  };
}

function commitStagedOperations(staged: readonly StagedOperation[]): void {
  const seen = new Set<string>();
  for (const op of staged) {
    if (seen.has(op.name) || getHandler(op.name) !== undefined) {
      throw new Error(`operation already registered: ${op.name}`);
    }
    seen.add(op.name);
  }
  for (const op of staged) {
    registerPluginOperation(op.name, op.input, op.output, op.handler);
  }
}

export async function registerAgentPlugins(entries: readonly AgentPluginConfigEntry[]): Promise<void> {
  for (const entry of entries) {
    if (!entry.enabled) continue;
    const staged: StagedOperation[] = [];
    try {
      if (!PLUGIN_ID.test(entry.plugin.id)) {
        throw new Error(`invalid plugin id: '${entry.plugin.id}'`);
      }
      await entry.plugin.setup(buildContext(entry.plugin.id, staged));
    } catch (error) {
      logger.error('agent plugin setup failed', { plugin_id: entry.plugin.id, err: getErrorMessage(error) });
      continue;
    }
    try {
      commitStagedOperations(staged);
      logger.info('agent plugin registered', { plugin_id: entry.plugin.id });
    } catch (error) {
      logger.error('agent plugin operation registration failed', {
        plugin_id: entry.plugin.id,
        err: getErrorMessage(error),
      });
    }
  }
}
