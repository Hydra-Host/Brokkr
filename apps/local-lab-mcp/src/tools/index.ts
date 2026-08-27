import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LabContext } from '../client.js';
import { registerBuildTools } from './builds.js';
import { registerDatastoreTools } from './datastore.js';
import { registerFleetTools } from './fleet.js';
import { registerHubTools } from './hub.js';
import { registerRunTools } from './runs.js';
import { registerStackTargetTools } from './stack-target.js';
import { registerStackTools } from './stack.js';
import { registerStatusTools } from './status.js';
import { registerTestTools } from './tests.js';

export interface ToolOptions {
  allowDestructive: boolean;
}

export function registerAllTools(server: McpServer, ctx: LabContext, options: ToolOptions): void {
  // first: it is the only stack read that works before a target resolves
  registerStackTargetTools(server, ctx);
  registerStatusTools(server, ctx);
  registerStackTools(server, ctx, options);
  registerRunTools(server, ctx);
  registerFleetTools(server, ctx, options);
  registerTestTools(server, ctx, options);
  registerDatastoreTools(server, ctx, options);
  registerHubTools(server, ctx);
  registerBuildTools(server, ctx, options);
}
