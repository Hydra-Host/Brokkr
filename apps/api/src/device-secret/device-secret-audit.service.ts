import { Injectable } from '@nestjs/common';
import {
  DeviceSecretActorType,
  DeviceSecretAuditEventType,
  DeviceSecretKind,
  DeviceSecretPurpose,
  Prisma,
} from '@repo/database';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';

export interface DeviceSecretActor {
  type: DeviceSecretActorType;
  id: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export interface DeviceSecretAuditInput {
  deviceId?: string | null;
  zoneId?: string | null;
  event: DeviceSecretAuditEventType;
  purpose?: DeviceSecretPurpose | null;
  actor: DeviceSecretActor;
  kind?: DeviceSecretKind | null;
  version?: number | null;
  requestId?: string | null;
  /** Structured cause/context — MUST NEVER contain secret material. */
  payload?: Prisma.InputJsonValue;
}

@Injectable()
export class DeviceSecretAuditService {
  constructor(
    private readonly prisma: PrismaClient,
    @Logger(DeviceSecretAuditService.name) private readonly logger: LoggerService,
  ) {}

  async record(input: DeviceSecretAuditInput, client?: Prisma.TransactionClient): Promise<void> {
    // Scope invariant (also a DB CHECK): device OR zone, never neither — caller bug, throw on both paths.
    if (!input.deviceId && !input.zoneId) {
      throw new Error(`DeviceSecretAuditEvent ${input.event} requires a deviceId or zoneId scope`);
    }
    const data: Prisma.DeviceSecretAuditEventCreateInput = {
      ...(input.deviceId ? { deviceId: input.deviceId } : { zoneId: input.zoneId ?? null }),
      event: input.event,
      purpose: input.purpose ?? null,
      kind: input.kind ?? null,
      version: input.version ?? null,
      actorType: input.actor.type,
      actor: input.actor.id,
      requestId: input.requestId ?? null,
      ip: input.actor.ip ?? null,
      userAgent: input.actor.userAgent ?? null,
      ...(input.payload === undefined ? {} : { payload: input.payload }),
    };

    if (client) {
      await client.deviceSecretAuditEvent.create({ data });
      return;
    }

    try {
      await this.prisma.deviceSecretAuditEvent.create({ data });
    } catch (error) {
      this.logger.error(
        `Failed to persist device-secret audit event ${input.event} for ${input.deviceId ? `device ${input.deviceId}` : `zone ${input.zoneId}`} ` +
          `(${input.purpose ?? 'unknown-purpose'}${input.version != null ? ` v${input.version}` : ''}): ${getErrorMessage(error)}`,
      );
    }
  }
}
