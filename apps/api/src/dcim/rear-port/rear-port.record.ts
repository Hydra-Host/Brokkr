import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import { PortType } from '@repo/database';
import type { PaginatedResult, PaginationQuery } from '@repo/database/pagination';
import { paginateQuery } from '@repo/database/pagination';
import { z } from 'zod';
import { assertParentDeviceReachable } from '../parent-device.utils';
import { rearPortPaginationConfig } from './rear-port.pagination';

export const RearPortPersistenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  positions: z.number(),
  description: z.string().nullable(),
  deviceId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface CreateRearPortInput {
  name: string;
  type: PortType;
  positions?: number;
  description?: string | null;
}

export interface UpdateRearPortInput {
  name?: string;
  type?: PortType;
  positions?: number;
  description?: string | null;
}

export class RearPortRecord extends createActiveRecord(RearPortPersistenceSchema, 'rearPort', {
  tenantField: 'device.supplierId',
  actions: { read: 'dcim:read', create: 'dcim:create', update: 'dcim:update', delete: 'dcim:delete' },
}) {
  static async listPaginated(query: PaginationQuery): Promise<PaginatedResult<RearPortRecord>> {
    this.requireAction('read');
    const result = await paginateQuery<z.infer<typeof RearPortPersistenceSchema>>(
      this._delegate(),
      query,
      rearPortPaginationConfig,
    );
    return {
      ...result,
      data: result.data.map((row) => this.fromRow(row)),
    };
  }

  static async findByIdOrThrow(id: string): Promise<RearPortRecord> {
    this.requireAction('read');
    const record = await this.findOne({ where: { id } });
    if (!record) {
      throw new NotFoundException('Rear port not found');
    }
    return record;
  }

  static async createForDevice(deviceId: string, input: CreateRearPortInput): Promise<RearPortRecord> {
    this.requireAction('create');
    const ctx = ActiveRecordRegistry.context;
    if (!ctx) {
      throw new BadRequestException('No active organization in request context');
    }
    await assertParentDeviceReachable(deviceId, ctx.organizationId);
    await this.ensureNameUnique(deviceId, input.name);

    const delegate = this._unscopedDelegate();
    const created = await delegate.create({
      data: {
        deviceId,
        name: input.name,
        type: input.type,
        positions: input.positions ?? 1,
        description: input.description ?? undefined,
      },
    });

    return new this(created, 'persisted');
  }

  static async updateById(id: string, input: UpdateRearPortInput): Promise<RearPortRecord> {
    this.requireAction('update');
    const record = await this.findByIdOrThrow(id);

    if (input.name !== undefined) {
      await this.ensureNameUnique(record.data.deviceId, input.name, id);
    }

    if (input.positions !== undefined) {
      await this.ensurePositionsNotBelowFrontPortCount(id, input.positions);
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
      throw new ConflictException('Rear port name must be unique per device');
    }
  }

  private static async ensurePositionsNotBelowFrontPortCount(rearPortId: string, newPositions: number) {
    const client = ActiveRecordRegistry.client;
    const count = await client.frontPort.count({ where: { rearPortId } });
    if (newPositions < count) {
      throw new BadRequestException(`Cannot reduce positions below ${count} (${count} front ports are mapped)`);
    }
  }
}
