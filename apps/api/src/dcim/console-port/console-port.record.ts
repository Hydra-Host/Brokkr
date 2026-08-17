import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import { ConsolePortType } from '@repo/database';
import type { PaginatedResult, PaginationQuery } from '@repo/database/pagination';
import { paginateQuery } from '@repo/database/pagination';
import { z } from 'zod';
import { assertParentDeviceReachable } from '../parent-device.utils';
import { consolePortPaginationConfig } from './console-port.pagination';

export const ConsolePortPersistenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().nullable(),
  speed: z.number().nullable(),
  description: z.string().nullable(),
  deviceId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface CreateConsolePortInput {
  name: string;
  type?: ConsolePortType | null;
  speed?: number | null;
  description?: string | null;
}

export interface UpdateConsolePortInput {
  name?: string;
  type?: ConsolePortType | null;
  speed?: number | null;
  description?: string | null;
}

export class ConsolePortRecord extends createActiveRecord(ConsolePortPersistenceSchema, 'consolePort', {
  tenantField: 'device.supplierId',
  actions: { read: 'dcim:read', create: 'dcim:create', update: 'dcim:update', delete: 'dcim:delete' },
}) {
  static async listPaginated(query: PaginationQuery): Promise<PaginatedResult<ConsolePortRecord>> {
    this.requireAction('read');
    const result = await paginateQuery<z.infer<typeof ConsolePortPersistenceSchema>>(
      this._delegate(),
      query,
      consolePortPaginationConfig,
    );
    return {
      ...result,
      data: result.data.map((row) => this.fromRow(row)),
    };
  }

  static async findByIdOrThrow(id: string): Promise<ConsolePortRecord> {
    this.requireAction('read');
    const record = await this.findOne({ where: { id } });
    if (!record) {
      throw new NotFoundException('Console port not found');
    }
    return record;
  }

  static async createForDevice(deviceId: string, input: CreateConsolePortInput): Promise<ConsolePortRecord> {
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
        type: input.type ?? undefined,
        speed: input.speed ?? undefined,
        description: input.description ?? undefined,
      },
    });
    return new this(created, 'persisted');
  }

  static async updateById(id: string, input: UpdateConsolePortInput): Promise<ConsolePortRecord> {
    this.requireAction('update');
    const record = await this.findByIdOrThrow(id);

    if (input.name !== undefined) {
      await this.ensureNameUnique(record.data.deviceId, input.name, id);
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
      throw new ConflictException('Console port name must be unique per device');
    }
  }
}
