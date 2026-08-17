import { z } from 'zod';
import { getAuthenticatedMcpClient, type CliApiClient } from '../core/client.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }> };
type ToolError = ToolResult & { isError: true };

export const paginationSchema = {
  page: z.number().int().min(1).default(1).describe('Page number (1-based)'),
  pageSize: z.number().int().min(1).max(100).default(20).describe('Results per page'),
};

export function ok(data?: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data ?? { success: true }) }] };
}

export function err(error: unknown): ToolError {
  return {
    isError: true,
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
  };
}

export async function withClient<T>(fn: (client: CliApiClient) => Promise<T>): Promise<ToolResult | ToolError> {
  try {
    return ok(await fn(getAuthenticatedMcpClient()));
  } catch (error) {
    return err(error);
  }
}

export async function withoutClient<T>(fn: () => Promise<T>): Promise<ToolResult | ToolError> {
  try {
    return ok(await fn());
  } catch (error) {
    return err(error);
  }
}
