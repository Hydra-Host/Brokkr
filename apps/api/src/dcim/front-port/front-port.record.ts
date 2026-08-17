import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import { PortType } from '@repo/database';
import type { PaginatedResult, PaginationQuery } from '@repo/database/pagination';
import { paginateQuery } from '@repo/database/pagination';
import { z } from 'zod';
import { assertParentDeviceReachable } from '../parent-device.utils';
import { RearPortRecord } from '../rear-port/rear-port.record';
import { frontPortPaginationConfig } from './front-port.pagination';

export const FrontPortPersistenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  rearPortPosition: z.number(),
  description: z.string().nullable(),
  deviceId: z.string(),
  rearPortId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface CreateFrontPortInput {
  name: string;
  type: PortType;
  rearPortId: string;
  rearPortPosition?: number;
  description?: string | null;
}

export interface UpdateFrontPortInput {
  name?: string;
  type?: PortType;
  rearPortId?: string;
  rearPortPosition?: number;
  description?: string | null;
}

export class FrontPortRecord extends createActiveRecord(FrontPortPersistenceSchema, 'frontPort', {
  tenantField: 'device.supplierId',
  actions: { read: 'dcim:read', create: 'dcim:create', update: 'dcim:update', delete: 'dcim:delete' },
}) {
  static async listPaginated(query: PaginationQuery): Promise<PaginatedResult<FrontPortRecord>> {
    this.requireAction('read');
    const result = await paginateQuery<z.infer<typeof FrontPortPersistenceSchema>>(
      this._delegate(),
      query,
      frontPortPaginationConfig,
    );
    return {
      ...result,
      data: result.data.map((row) => this.fromRow(row)),
    };
  }

  static async findByIdOrThrow(id: string): Promise<FrontPortRecord> {
    this.requireAction('read');
    const record = await this.findOne({ where: { id } });
    if (!record) {
      throw new NotFoundException('Front port not found');
    }
    return record;
  }

  static async createForDevice(deviceId: string, input: CreateFrontPortInput): Promise<FrontPortRecord> {
    this.requireAction('create');
    const ctx = ActiveRecordRegistry.context;
    if (!ctx) {
      throw new BadRequestException('No active organization in request context');
    }
    await assertParentDeviceReachable(deviceId, ctx.organizationId);
    await this.ensureNameUnique(deviceId, input.name);

    const rearPort = await RearPortRecord.findByIdOrThrow(input.rearPortId);
    assertRearPortBelongsToDevice(rearPort.data.deviceId, deviceId);
    const position = input.rearPortPosition ?? 1;
    assertValidRearPortPosition(position, rearPort.data.positions);

    const delegate = this._unscopedDelegate();
    const created = await delegate.create({
      data: {
        deviceId,
        name: input.name,
        type: input.type,
        rearPortId: input.rearPortId,
        rearPortPosition: position,
        description: input.description ?? undefined,
      },
    });
    return new this(created, 'persisted');
  }

  static async updateById(id: string, input: UpdateFrontPortInput): Promise<FrontPortRecord> {
    this.requireAction('update');
    const record = await this.findByIdOrThrow(id);

    if (input.name !== undefined) {
      await this.ensureNameUnique(record.data.deviceId, input.name, id);
    }

    if (input.rearPortId !== undefined || input.rearPortPosition !== undefined) {
      const effectiveRearPortId = input.rearPortId ?? record.data.rearPortId;
      const effectivePosition = input.rearPortPosition ?? record.data.rearPortPosition;
      const rearPort = await RearPortRecord.findByIdOrThrow(effectiveRearPortId);
      assertRearPortBelongsToDevice(rearPort.data.deviceId, record.data.deviceId);
      assertValidRearPortPosition(effectivePosition, rearPort.data.positions);
    }

    record.set(input);
    await record.save();
    return record;
  }

  static async deleteById(id: string): Promise<void> {
    this.requireAction('delete');
    const record = await this.findByIdOrThrow(id);
    await record.delete();
  }

  private static async ensureNameUnique(deviceId: string, name: string, excludeId?: string) {
    const delegate = this._unscopedDelegate();
    const existing = await delegate.findFirst({
      where: { deviceId, name, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (existing) {
      throw new ConflictException('Front port name must be unique per device');
    }
  }
}

export function assertRearPortBelongsToDevice(rearPortDeviceId: string, expectedDeviceId: string): void {
  if (rearPortDeviceId !== expectedDeviceId) {
    throw new BadRequestException('Rear port must belong to the same device');
  }
}

export function assertValidRearPortPosition(rearPortPosition: number, maxPositions: number): void {
  if (rearPortPosition < 1 || rearPortPosition > maxPositions) {
    throw new BadRequestException(`Rear port position must be between 1 and ${maxPositions}`);
  }
}
