import { operations, type OperationInput, type OperationName, type OperationOutput } from '@repo/bridge-agent-protocol';

import { getHandler, type HandlerContext } from './registry';

export async function callHandler<N extends OperationName>(
  op: N,
  input: OperationInput<N>,
  ctx: HandlerContext,
): Promise<OperationOutput<N>> {
  if (ctx.signal.aborted) throw new Error(`sub-op '${op}' skipped: parent operation was cancelled`);
  const reg = getHandler(op);
  if (!reg) throw new Error(`sub-op not registered: ${op}`);
  const raw = await reg.handler(input, ctx);
  return operations[op].output.parse(raw);
}
