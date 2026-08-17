import type { LabClient, LabContext } from './client.js';
import labUtilsPkg from './lab-utils.js';

const { isRecord } = labUtilsPkg;

export type ToolResult = { content: Array<{ type: 'text'; text: string }> };
export type ToolError = ToolResult & { isError: true };

export function ok(data?: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data ?? { success: true }) }] };
}

export function err(error: unknown): ToolError {
  return {
    isError: true,
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
  };
}

export function failOnError<T extends { status: number; body: unknown }>(
  res: T,
  label: string,
): asserts res is Extract<T, { status: 200 }> {
  if (res.status !== 200) {
    const body = res.body;
    const detail =
      (isRecord(body) && typeof body.error === 'string' && body.error) ||
      (isRecord(body) && typeof body.message === 'string' && body.message) ||
      `HTTP ${res.status}`;
    throw new Error(`${label}: ${detail}`);
  }
}

export async function call(
  ctx: LabContext,
  fn: (client: LabClient) => Promise<unknown>,
): Promise<ToolResult | ToolError> {
  try {
    return ok(await fn(ctx.client));
  } catch (error) {
    return err(error);
  }
}
