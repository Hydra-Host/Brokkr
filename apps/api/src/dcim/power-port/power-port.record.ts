import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import { PowerPortType } from '@repo/database';
import type { PaginatedResult, PaginationQuery } from '@repo/database/pagination';
import { paginateQuery } from '@repo/database/pagination';
import { z } from 'zod';
import { assertParentDeviceReachable } from '../parent-device.utils';
import { powerPortPaginationConfig } from './power-port.pagination';

export const PowerPortPersistenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().nullable(),
  maximumDraw: z.number().nullable(),
  allocatedDraw: z.number().nullable(),
  description: z.string().nullable(),
  deviceId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface CreatePowerPortInput {
  name: string;
  type?: PowerPortType | null;
  maximumDraw?: number | null;
  allocatedDraw?: number | null;
  description?: string | null;
}

export interface UpdatePowerPortInput {
  name?: string;
  type?: PowerPortType | null;
  maximumDraw?: number | null;
  allocatedDraw?: number | null;
  description?: string | null;
}

export class PowerPortRecord extends createActiveRecord(PowerPortPersistenceSchema, 'powerPort', {
  tenantField: 'device.supplierId',
  actions: { read: 'dcim:read', create: 'dcim:create', update: 'dcim:update', delete: 'dcim:delete' },
}) {
  static async listPaginated(query: PaginationQuery): Promise<PaginatedResult<PowerPortRecord>> {
    this.requireAction('read');
    const result = await paginateQuery<z.infer<typeof PowerPortPersistenceSchema>>(
      this._delegate(),
      query,
      powerPortPaginationConfig,
    );
    return {
      ...result,
      data: result.data.map((row) => this.fromRow(row)),
    };
  }

  static async findByIdOrThrow(id: string): Promise<PowerPortRecord> {
    this.requireAction('read');
    const record = await this.findOne({ where: { id } });
    if (!record) {
      throw new NotFoundException('Power port not found');
    }
    return record;
  }

  static async createForDevice(deviceId: string, input: CreatePowerPortInput): Promise<PowerPortRecord> {
    this.requireAction('create');
    const ctx = ActiveRecordRegistry.context;
    if (!ctx) {
      throw new BadRequestException('No active organization in request context');
    }
    await assertParentDeviceReachable(deviceId, ctx.organizationId);
    await this.ensureNameUnique(deviceId, input.name);
    this.validateDraw(input.maximumDraw, input.allocatedDraw);

    const delegate = this._unscopedDelegate();
    const created = await delegate.create({
      data: {
        deviceId,
        name: input.name,
        type: input.type ?? undefined,
        maximumDraw: input.maximumDraw ?? undefined,
        allocatedDraw: input.allocatedDraw ?? undefined,
        description: input.description ?? undefined,
      },
    });
    return new this(created, 'persisted');
  }

  static async updateById(id: string, input: UpdatePowerPortInput): Promise<PowerPortRecord> {
    this.requireAction('update');
    const record = await this.findByIdOrThrow(id);

    if (input.name !== undefined) {
      await this.ensureNameUnique(record.data.deviceId, input.name, id);
    }

    record.set(input);
    this.validateDraw(record.data.maximumDraw, record.data.allocatedDraw);

    await record.save();
    return record;
  }

  static async deleteById(id: string): Promise<void> {
    this.requireAction('delete');
    const record = await this.findByIdOrThrow(id);
    await record.delete();
  }

  private static validateDraw(maximumDraw?: number | null, allocatedDraw?: number | null) {
    if (maximumDraw != null && allocatedDraw != null && allocatedDraw > maximumDraw) {
      throw new BadRequestException('Allocated draw cannot exceed maximum draw');
    }
  }

  private static async ensureNameUnique(deviceId: string, name: string, excludeId?: string) {
    const delegate = this._unscopedDelegate();
    const existing = await delegate.findFirst({
      where: { deviceId, name, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (existing) {
      throw new ConflictException('Power port name must be unique per device');
    }
  }
}
