#!/usr/bin/env node

// stdout is the MCP stdio wire — nothing imported here may write to it.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLabContext } from './client.js';
import { registerAllTools } from './tools/index.js';

const server = new McpServer({ name: 'brokkr-lab', version: '0.0.0-dev' });

registerAllTools(server, createLabContext(), {
  allowDestructive: process.env.LAB_MCP_ALLOW_DESTRUCTIVE === '1',
});

await server.connect(new StdioServerTransport());
