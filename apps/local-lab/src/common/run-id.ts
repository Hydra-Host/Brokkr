import { NotFoundException } from '@nestjs/common';

// run ids reach path builders straight off `:runId` route params, and express decodes %2F before the
// handler sees it — so anything that is not one safe segment is rejected rather than rewritten.
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeRunId(runId: string): boolean {
  return SAFE_RUN_ID.test(runId);
}

export function assertSafeRunId(runId: string): void {
  if (!isSafeRunId(runId)) throw new NotFoundException(`unknown run '${runId}'`);
}
