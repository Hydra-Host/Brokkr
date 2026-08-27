import type { EventDurability, EventOutcome, EventTier, RequestSource } from '@repo/database';

export type EventLogJsonValue =
  | string
  | number
  | boolean
  | null
  | EventLogJsonValue[]
  | { [key: string]: EventLogJsonValue };

/** Allowlisted extras only — never a request body, and never anything that could carry a secret. */
export type EventLogMetadata = Record<string, EventLogJsonValue>;

/** The single write shape every capture path produces — tier 1 emits, the tier 2 interceptor,
 *  and EventLogSystemFinalizer for headless runAsSystem scopes. */
export interface EventLogWrite {
  organizationId: string;

  tier: EventTier;
  durability: EventDurability;
  resource: string;
  action: string;
  actionKey: string;

  actorType: RequestSource;
  actorId?: string | null;
  actorLabel?: string | null;
  apiKeyId?: string | null;
  apiKeyLabel?: string | null;

  targetId?: string | null;
  targetLabel?: string | null;

  outcome: EventOutcome;
  errorCode?: string | null;

  requestId?: string | null;
  method?: string | null;
  path?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;

  metadata?: EventLogMetadata | null;
}

export interface EventLogAccessBucketWrite {
  organizationId: string;
  actorKey: string;
  hourBucket: Date;
}
