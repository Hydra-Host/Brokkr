import { Injectable, Logger } from '@nestjs/common';
import { getErrorMessage } from '../common/error-utils';

import { JobStatus } from './state.types';

export interface SagaLoggerLike {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export class NotificationDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationDeliveryError';
  }
}

function defaultLogger(name: string): SagaLoggerLike {
  const nest = new Logger(name);
  return {
    info: (message: string) => nest.log(message),
    warn: (message: string) => nest.warn(message),
    error: (message: string) => nest.error(message),
  };
}

export const LOCK_WAIT_STEP_NAME = 'lock_wait';
export const AGENT_WAIT_STEP_NAME = 'agent_wait';
export type EventType = 'job_failed' | 'job_completed' | 'job_blocked' | 'stage_changed';
type NotificationStatus = JobStatus | `${JobStatus}`;

export function classifyEventType(status: NotificationStatus, stepName: string): EventType {
  if (status === JobStatus.BLOCKED && stepName === LOCK_WAIT_STEP_NAME) return 'job_blocked';
  if (status === JobStatus.FAILED) return 'job_failed';
  if (status === JobStatus.COMPLETED && stepName === '__plan__') return 'job_completed';
  return 'stage_changed';
}

export interface StepTransitionEvent {
  planId: string;
  stepName: string;
  operation?: string | null;
  status: JobStatus;
  deviceId: unknown;
  error?: string | null;
  result?: unknown;
  attempt?: number;
  metadata: Record<string, unknown>;
}

export interface ResultsQueueProducer {
  enqueueResult(args: {
    planId: string;
    stepName: string;
    operation: string | null;
    status: string;
    deviceId: unknown;
    eventType: EventType;
    actionType: string;
    result?: unknown;
    error?: string | null;
    attempt: number;
    metadata: Record<string, unknown>;
  }): Promise<boolean>;
  enqueueJobCompleted(args: {
    planId: string;
    deviceId: unknown;
    sagaName: string;
    status: string;
    error?: string | null;
    metadata: Record<string, unknown>;
  }): Promise<boolean>;
}

@Injectable()
export class NotificationsService {
  private readonly logger: SagaLoggerLike;
  private readonly producer: ResultsQueueProducer | null;

  constructor(producer?: ResultsQueueProducer | null, logger?: SagaLoggerLike) {
    this.producer = producer ?? null;
    this.logger = logger ?? defaultLogger(NotificationsService.name);
  }

  async notifyStepTransition(event: StepTransitionEvent): Promise<void> {
    if (this.producer === null) {
      const message = `Results queue producer unavailable for plan ${event.planId} step ${event.stepName}`;
      this.logger.warn(message);
      throw new NotificationDeliveryError(message);
    }

    const meta = event.metadata;
    const sagaName = meta.saga_name;
    if (typeof sagaName !== 'string' || sagaName.length === 0) {
      throw new Error(`Missing saga_name in metadata for plan ${event.planId} step ${event.stepName}`);
    }
    const eventType = classifyEventType(event.status, event.stepName);
    const attempt = event.attempt ?? 0;

    let delivered: boolean;
    try {
      if (eventType === 'job_completed') {
        delivered = await this.producer.enqueueJobCompleted({
          planId: event.planId,
          deviceId: event.deviceId,
          sagaName,
          status: event.status,
          error: event.error ?? null,
          metadata: meta,
        });
      } else {
        delivered = await this.producer.enqueueResult({
          planId: event.planId,
          stepName: event.stepName,
          operation: event.operation ?? null,
          status: event.status,
          deviceId: event.deviceId,
          eventType,
          actionType: sagaName,
          result: event.result ?? null,
          error: event.error ?? null,
          attempt,
          metadata: meta,
        });
      }
    } catch (error) {
      const message = `BullMQ notification threw for plan ${event.planId} step ${event.stepName}: ${getErrorMessage(error)}`;
      this.logger.warn(message);
      throw new NotificationDeliveryError(message);
    }

    if (!delivered) {
      const message = `Results queue rejected notification for plan ${event.planId} step ${event.stepName}`;
      this.logger.warn(message);
      throw new NotificationDeliveryError(message);
    }
  }
}
