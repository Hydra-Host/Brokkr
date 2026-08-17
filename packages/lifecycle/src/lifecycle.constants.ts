export const DEFAULT_INTERRUPTIBLE_NOTICE_MS = 300_000;

export function interruptibleEvictionRequiresApproval(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.INTERRUPTIBLE_EVICTION_REQUIRES_APPROVAL !== 'false';
}
