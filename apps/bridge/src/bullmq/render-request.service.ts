import { Injectable, Optional } from '@nestjs/common';
import { getErrorMessage } from '../common/error-utils';

import { renderRequestSchema, type RenderReason } from '../device-record/atom/render-request.schema';
import { ContextLogger } from '../logger/logger.service';

import { RESULT_JOB_NAME } from './bullmq.types';
import { buildRenderRequestPayload } from './results.payloads';
import { sealOutboundPayload, type ZoneCryptoState } from './seal-outbound-payload';

export interface RenderRequestQueueAddOptions {
  removeOnComplete: { count: number };
  removeOnFail: { count: number };
}

export interface RenderRequestQueue {
  name: string;
  add(name: string, data: object, opts: RenderRequestQueueAddOptions): Promise<unknown>;
}

export interface ResultsQueueProvider {
  getResultsQueue(): Promise<RenderRequestQueue | null>;
  resetSharedOpsStateOnConnectionError(exc: unknown): Promise<boolean>;
}

export interface ZoneIdProvider {
  getZoneId(): string;
}

export interface ZoneCryptoStateProvider {
  getZoneCryptoState(): ZoneCryptoState | null;
}

export interface EnqueueRenderRequestArgs {
  requestId: string;
  domain: string;
  bridgeId: string;
  entityId?: string | null;
  params?: Record<string, unknown> | null;
  reason?: RenderReason | null;
}

@Injectable()
export class BullmqRenderRequestService {
  private readonly logger: ContextLogger;

  constructor(
    private readonly queues: ResultsQueueProvider,
    private readonly zoneId: ZoneIdProvider,
    private readonly zoneCrypto: ZoneCryptoStateProvider,
    @Optional() logger?: ContextLogger,
  ) {
    this.logger = logger ?? new ContextLogger();
  }

  async enqueueRenderRequest(args: EnqueueRenderRequestArgs): Promise<boolean> {
    const queue = await this.queues.getResultsQueue();
    if (queue === null) {
      void this.logger.warning(
        `Results queue unavailable, cannot send render.request domain=${args.domain} entity=${args.entityId ?? 'unknown'}`,
      );
      return false;
    }

    try {
      const payload = buildRenderRequestPayload({
        request_id: args.requestId,
        zone_id: this.zoneId.getZoneId(),
        bridge_id: args.bridgeId,
        domain: args.domain,
        entity_id: args.entityId,
        params: args.params,
        reason: args.reason,
      });

      const validation = renderRequestSchema.safeParse(payload);
      if (!validation.success) {
        void this.logger.warning(
          `Refusing to enqueue malformed render.request domain=${args.domain} entity=${args.entityId ?? 'unknown'}: ${validation.error.message}`,
        );
        return false;
      }

      await queue.add(
        RESULT_JOB_NAME.RENDER_REQUEST,
        sealOutboundPayload(payload, {
          queueName: queue.name,
          aadJobId: args.requestId,
          zoneCrypto: this.zoneCrypto.getZoneCryptoState(),
        }),
        {
          removeOnComplete: { count: 0 },
          removeOnFail: { count: 1000 },
        },
      );
      return true;
    } catch (exc) {
      await this.queues.resetSharedOpsStateOnConnectionError(exc);
      void this.logger.warning(
        `Failed to enqueue render.request domain=${args.domain} entity=${args.entityId ?? 'unknown'}: ${getErrorMessage(exc)}`,
      );
      return false;
    }
  }
}
