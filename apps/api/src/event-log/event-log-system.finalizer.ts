import { Injectable } from '@nestjs/common';
import { RequestSource } from '@repo/database';
import type { PermissionIntent, SystemFinalizeInput, SystemIntentFinalizer } from 'src/common/context/context.service';
import { resolveOutcome } from 'src/common/context/permission-intents';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { resolveErrorCode } from './event-log-status-mapper';
import { EventLogService } from './event-log.service';
import type { EventLogWrite } from './event-log.types';

/** Writes the SYSTEM rows a headless scope's drained intents describe. The organization and
 *  request id are passed in, so nothing here depends on an HTTP request being in flight. */
@Injectable()
export class EventLogSystemFinalizer implements SystemIntentFinalizer {
  constructor(
    private readonly eventLog: EventLogService,
    @Logger(EventLogSystemFinalizer.name) private readonly logger: LoggerService,
  ) {}

  /** Must never reject: this runs on the system operation's own path, so a failed audit
   *  write would otherwise turn a successful operation into a failure. */
  async finalize(input: SystemFinalizeInput): Promise<void> {
    // Per intent, not around the loop: one failed write must not swallow the rows behind it.
    for (const intent of input.intents) {
      try {
        await this.eventLog.recordBestEffort(this.toWrite(input, intent));
      } catch (error) {
        this.logger.error(
          `Failed to finalize system event intent ${intent.resource}.${intent.action}: ${getErrorMessage(error)}`,
        );
      }
    }
  }

  private toWrite(input: SystemFinalizeInput, intent: PermissionIntent): EventLogWrite {
    return {
      organizationId: input.organizationId,
      tier: 'ACTIVITY',
      durability: 'BEST_EFFORT',
      resource: intent.resource,
      action: intent.action,
      actionKey: `${intent.resource}.${intent.action}`,
      actorType: RequestSource.SYSTEM,
      actorId: null,
      actorLabel: null,
      apiKeyId: null,
      apiKeyLabel: null,
      targetId: null,
      targetLabel: null,
      outcome: resolveOutcome(intent, input.error),
      errorCode: input.error === undefined ? null : resolveErrorCode(input.error),
      requestId: input.requestId,
      // No request to read: a system scope has no method, path, or caller address.
      method: null,
      path: null,
      ipAddress: null,
      userAgent: null,
      metadata: null,
    };
  }
}
