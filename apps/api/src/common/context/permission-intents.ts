import { MAIN_APP_PERMISSIONS, isMutatingPermission, permissionKey } from '@repo/auth/rbac';
import type { EventOutcome } from '@repo/database';
import type { PermissionIntent } from './context.service';

/** The intent bookkeeping every capture path shares; ContextService satisfies it structurally. */
export interface IntentSource {
  readonly hasRecordedIntents: boolean;
  drainIntents(): PermissionIntent[];
}

/** `options` is the @AuditAction decorator's fallback pair, taken structurally so this stays
 *  independent of the event-log module. */
export function selectIntents(
  source: IntentSource,
  options: { resource: string; action: string } | undefined,
): PermissionIntent[] {
  // A tier 1 emit supersedes its gate's intent, so an empty drain here means the row is
  // already written — minting a synthetic one would duplicate it.
  const gated = source.hasRecordedIntents;
  // Denied intents survive classification: a refused read is the security signal, and the
  // caller never reaches the success-path logger that would otherwise record it.
  const drained = source
    .drainIntents()
    .filter(
      (intent) =>
        intent.denied || isMutatingPermission(MAIN_APP_PERMISSIONS, permissionKey(intent.resource, intent.action)),
    );
  if (drained.length > 0 || gated || !options) return drained;

  return [{ id: 'synthetic', resource: options.resource, action: options.action, denied: false, finalized: false }];
}

export function resolveOutcome(intent: PermissionIntent, error: unknown): EventOutcome {
  if (intent.denied) return 'DENIED';
  // Any handler error, including a business 403 thrown after the check passed.
  if (error !== undefined) return 'FAILED';
  return 'SUCCEEDED';
}
