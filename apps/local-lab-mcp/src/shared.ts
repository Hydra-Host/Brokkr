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

// a separate content block, never a prefix inside the existing one: that block is the JSON payload
// callers parse, and a marker spliced into it would corrupt every one of them.
export function withTargetNotice<T extends ToolResult>(ctx: LabContext, result: T): T {
  const notice = ctx.targetNotice;
  if (!notice) return result;
  return { ...result, content: [{ type: 'text', text: notice }, ...result.content] };
}

export async function call(
  ctx: LabContext,
  fn: (client: LabClient) => Promise<unknown>,
): Promise<ToolResult | ToolError> {
  try {
    return withTargetNotice(ctx, ok(await fn(ctx.client)));
  } catch (error) {
    return withTargetNotice(ctx, err(error));
  }
}
