#!/usr/bin/env node

// stdout is the MCP stdio wire — never import from src/ui/, src/commands/, or src/tui/ here.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAccountTools } from './tools/account.js';
import { registerDcimTools } from './tools/dcim.js';
import { registerDeploymentTools } from './tools/deployments.js';
import { registerInventoryTools } from './tools/inventory.js';
import { registerOrgTools } from './tools/org.js';

declare const BROKKR_CLI_VERSION: string | undefined;

const server = new McpServer({
  name: 'brokkr',
  version: typeof BROKKR_CLI_VERSION !== 'undefined' ? BROKKR_CLI_VERSION : '0.0.0-dev',
});

registerDeploymentTools(server);
registerDcimTools(server);
registerOrgTools(server);
registerInventoryTools(server);
registerAccountTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
