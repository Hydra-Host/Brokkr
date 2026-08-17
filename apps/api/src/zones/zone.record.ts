import { createActiveRecord, type SaveOptions } from '@repo/active-record';
import {
  toZoneAddress,
  ZoneAddressPersistenceSchema,
  type CreateZoneRequest,
  type Zone,
  type ZoneAddressPersistence,
  type ZoneBridge,
  type ZoneListItem,
} from '@repo/api-client';
import { z } from 'zod';

const ZonePersistenceSchema = z.object({
  id: z.string(),
  uuidSuffix: z.string().nullable(),
  internalName: z.string().nullable(),
  name: z.string(),
  organizationId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  deletedAt: z.date().nullable(),
  addresses: z.array(ZoneAddressPersistenceSchema).optional(),
  _count: z.object({ contacts: z.number() }).optional(),
});

export class ZoneRecord extends createActiveRecord(ZonePersistenceSchema, 'zone', {
  tenantField: 'organizationId',
  actions: {
    read: 'zone:read',
    create: 'zone:create',
    rename: 'zone:update',
    delete: 'zone:delete',
  },
}) {
  static findAllActive(): Promise<ZoneRecord[]> {
    this.requireAction('read');
    return this.findMany({
      where: { deletedAt: null },
      include: {
        addresses: { where: { deletedAt: null } },
        _count: { select: { contacts: { where: { deletedAt: null } } } },
      },
      orderBy: { name: 'asc' },
    });
  }

  static findActiveById(id: string, opts?: Pick<SaveOptions, 'tx'>): Promise<ZoneRecord | null> {
    this.requireAction('read');
    return this.findOne({ where: { id, deletedAt: null } }, opts);
  }

  static findFullActiveById(id: string): Promise<ZoneRecord | null> {
    this.requireAction('read');
    return this.findOne({
      where: { id, deletedAt: null },
      include: {
        addresses: { where: { deletedAt: null } },
        _count: { select: { contacts: { where: { deletedAt: null } } } },
      },
    });
  }

  static fromCreateRequest(dto: CreateZoneRequest, id: string): ZoneRecord {
    this.requireAction('create');
    return ZoneRecord.build({ name: dto.name, id, uuidSuffix: id.slice(-5) });
  }

  get primaryAddress(): ZoneAddressPersistence | null {
    return this.data.addresses?.find((a) => a.type === 'PRIMARY') ?? null;
  }

  get shippingAddress(): ZoneAddressPersistence | null {
    return this.data.addresses?.find((a) => a.type === 'SHIPPING') ?? null;
  }

  rename(name: string): this {
    return this.set({ name });
  }

  override async delete(opts?: SaveOptions): Promise<void> {
    await this.set({ deletedAt: new Date() }).save(opts);
  }

  get isArchived(): boolean {
    return this.data.deletedAt !== null;
  }

  toResponse(bridges: ZoneBridge[] = []): Zone {
    return {
      id: this.data.id,
      name: this.data.name,
      organizationId: this.data.organizationId,
      primaryAddress: this.primaryAddress ? toZoneAddress(this.primaryAddress) : null,
      shippingAddress: this.shippingAddress ? toZoneAddress(this.shippingAddress) : null,
      bridges,
      createdAt: this.data.createdAt,
      updatedAt: this.data.updatedAt,
    };
  }

  toListItem(): ZoneListItem {
    return {
      id: this.data.id,
      name: this.data.name,
      organizationId: this.data.organizationId,
      primaryAddress: this.primaryAddress ? toZoneAddress(this.primaryAddress) : null,
      contactCount: this.data._count?.contacts ?? 0,
      createdAt: this.data.createdAt,
    };
  }
}
