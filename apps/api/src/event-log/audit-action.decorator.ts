import { SetMetadata } from '@nestjs/common';
import type { EventLogMetadata } from './event-log.types';

export const AUDIT_ACTION_KEY = 'event-log:audit-action';

export interface AuditActionTarget {
  id?: string | null;
  label?: string | null;
}

export interface AuditActionOptions {
  actionKey: string;
  /** Used to mint an intent where no authorization mechanism records one — operator/tenant guards also cover reads, so they are not instrumented. */
  resource: string;
  action: string;
  target?: (request: unknown, responseBody: unknown) => AuditActionTarget | undefined;
  metadata?: (request: unknown) => EventLogMetadata | undefined;
}

export const AuditAction = (options: AuditActionOptions): MethodDecorator => SetMetadata(AUDIT_ACTION_KEY, options);
