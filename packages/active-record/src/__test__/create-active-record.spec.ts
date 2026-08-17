import { ForbiddenException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ActiveRecordRegistry } from '../active-record.registry';
import { PermissionContextRequiredError, TenantContextRequiredError } from '../active-record.types';
import { createActiveRecord } from '../create-active-record';

const TestSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  active: z.boolean(),
});

const mockDelegate = {
  findUnique: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  findFirst: vi.fn(),
  findFirstOrThrow: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  aggregate: vi.fn(),
  groupBy: vi.fn(),
  create: vi.fn(),
  createMany: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  delete: vi.fn(),
  deleteMany: vi.fn(),
  upsert: vi.fn(),
};

class TestRecord extends createActiveRecord(TestSchema, 'testModel') {
  rename(name: string): this {
    return this.set({ name });
  }
}

const TenantSchema = z.object({
  id: z.string(),
  name: z.string(),
  organizationId: z.string(),
});

class TenantScopedRecord extends createActiveRecord(TenantSchema, 'testModel') {
  override _scopeWhere(): Record<string, unknown> {
    return { id: this.data.id, organizationId: this.data.organizationId };
  }
}

class PolicyScopedRecord extends createActiveRecord(TenantSchema, 'testModel', {
  tenantField: 'organizationId',
}) {}

class GatedRecord extends createActiveRecord(TenantSchema, 'testModel', {
  tenantField: 'organizationId',
  actions: { archive: 'widget:archive' },
}) {}

describe('createActiveRecord', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ActiveRecordRegistry.configureForTest({ testModel: mockDelegate });
  });

  describe('build', () => {
    it('creates a record with state new', () => {
      const record = TestRecord.build({ name: 'Alice', email: 'alice@test.com' });
      expect(record.state).toBe('new');
      expect(record.isNew).toBe(true);
      expect(record.isPersisted).toBe(false);
      expect(record.data.name).toBe('Alice');
    });

    it('does not validate partial data for new records', () => {
      const record = TestRecord.build({ name: 'Alice' });
      expect(record.state).toBe('new');
      expect(record.data.name).toBe('Alice');
      expect(record.data.id).toBeUndefined();
    });
  });

  describe('fromRow', () => {
    it('wraps a row in a persisted record without a DB query', () => {
      const row = { id: '1', name: 'Alice', email: 'a@test.com', active: true };

      const record = TestRecord.fromRow(row);

      expect(record.state).toBe('persisted');
      expect(record.isPersisted).toBe(true);
      expect(record.isNew).toBe(false);
      expect(record.isDirty).toBe(false);
      expect(record.data).toEqual(row);
      expect(mockDelegate.findFirst).not.toHaveBeenCalled();
      expect(mockDelegate.findUnique).not.toHaveBeenCalled();
    });

    it('strips relation/include fields not declared on the schema', () => {
      const rowWithRelations = {
        id: '1',
        name: 'Alice',
        email: 'a@test.com',
        active: true,
        relatedThing: { id: 'r1', label: 'extra' },
        otherRelation: [{ id: 'o1' }],
      };

      const record = TestRecord.fromRow(rowWithRelations);

      expect(record.data).toEqual({ id: '1', name: 'Alice', email: 'a@test.com', active: true });
      expect((record.data as Record<string, unknown>).relatedThing).toBeUndefined();
      expect((record.data as Record<string, unknown>).otherRelation).toBeUndefined();
    });

    it('produces a record that can be mutated and saved like any other persisted record', async () => {
      const row = { id: '1', name: 'Alice', email: 'a@test.com', active: true };
      mockDelegate.update.mockResolvedValue({ ...row, name: 'Bob' });

      const record = TestRecord.fromRow(row);
      record.set({ name: 'Bob' });
      await record.save();

      expect(record.isDirty).toBe(false);
      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: '1' },
        data: { name: 'Bob' },
      });
    });

    it('throws when the row does not match the schema', () => {
      const notARow = { id: '1', name: 'Alice' };
      expect(() => TestRecord.fromRow(notARow)).toThrow();
    });
  });

  describe('set', () => {
    it('tracks dirty fields in changes', () => {
      const record = TestRecord.build({ id: '1', name: 'Alice', email: 'a@test.com', active: true });
      record.set({ name: 'Bob' });

      expect(record.isDirty).toBe(true);
      expect(record.changes).toEqual({
        name: { from: 'Alice', to: 'Bob' },
      });
    });

    it('mutates `data` in place — reference is stable across set() calls', () => {
      const record = TestRecord.build({ id: '1', name: 'Alice', email: 'a@test.com', active: true });
      const before = record.data;

      record.set({ name: 'Bob' });

      expect(record.data).toBe(before);
      expect(before.name).toBe('Bob');
    });

    it('updates data in place', () => {
      const record = TestRecord.build({ id: '1', name: 'Alice', email: 'a@test.com', active: true });
      record.set({ name: 'Bob' });

      expect(record.data.name).toBe('Bob');
      expect(record.data.email).toBe('a@test.com');
    });

    it('accumulates multiple changes', () => {
      const record = TestRecord.build({ id: '1', name: 'Alice', email: 'a@test.com', active: true });
      record.set({ name: 'Bob' }).set({ email: 'bob@test.com' });

      expect(record.changes).toEqual({
        name: { from: 'Alice', to: 'Bob' },
        email: { from: 'a@test.com', to: 'bob@test.com' },
      });
    });

    it('tracks the original from value across multiple sets to the same field', () => {
      const record = TestRecord.build({ id: '1', name: 'Alice', email: 'a@test.com', active: true });
      record.set({ name: 'Bob' });
      record.set({ name: 'Charlie' });

      expect(record.changes).toEqual({
        name: { from: 'Alice', to: 'Charlie' },
      });
    });

    it('returns this for chaining', () => {
      const record = TestRecord.build({ id: '1', name: 'Alice', email: 'a@test.com', active: true });
      const result = record.set({ name: 'Bob' });
      expect(result).toBe(record);
    });
  });

  describe('isDirty', () => {
    it('returns false for a fresh record', () => {
      const record = TestRecord.build({ id: '1', name: 'Alice', email: 'a@test.com', active: true });
      expect(record.isDirty).toBe(false);
    });

    it('returns true after set', () => {
      const record = TestRecord.build({ id: '1', name: 'Alice', email: 'a@test.com', active: true });
      record.set({ name: 'Bob' });
      expect(record.isDirty).toBe(true);
    });
  });

  describe('save', () => {
    it('throws on deleted records', async () => {
      const row = { id: '1', name: 'Alice', email: 'a@test.com', active: true };
      mockDelegate.findFirst.mockResolvedValue(row);
      mockDelegate.delete.mockResolvedValue(row);

      const record = await TestRecord.findById('1');
      await record.delete();

      await expect(record.save()).rejects.toThrow('Cannot save a deleted record.');
    });

    it('creates via delegate for new records', async () => {
      const created = { id: 'gen-id', name: 'Alice', email: 'a@test.com', active: true };
      mockDelegate.create.mockResolvedValue(created);

      const record = TestRecord.build({ name: 'Alice', email: 'a@test.com', active: true });
      await record.save();

      expect(mockDelegate.create).toHaveBeenCalledWith({
        data: { name: 'Alice', email: 'a@test.com', active: true },
      });
      expect(record.state).toBe('persisted');
      expect(record.data.id).toBe('gen-id');
      expect(record.isDirty).toBe(false);
    });

    it('updates only dirty fields for persisted records', async () => {
      const row = { id: '1', name: 'Alice', email: 'a@test.com', active: true };
      mockDelegate.findFirst.mockResolvedValue(row);
      mockDelegate.update.mockResolvedValue({ ...row, name: 'Bob' });

      const record = await TestRecord.findById('1');
      record.set({ name: 'Bob' });
      await record.save();

      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: '1' },
        data: { name: 'Bob' },
      });
      expect(record.isDirty).toBe(false);
    });

    it('merges the update result into _data so DB-bumped fields (e.g. updatedAt) refresh after save', async () => {
      const row = { id: '1', name: 'Alice', email: 'a@test.com', active: true };
      mockDelegate.findFirst.mockResolvedValue(row);

      const updatedRow = { ...row, name: 'Bob' };
      mockDelegate.update.mockResolvedValue(updatedRow);

      const record = await TestRecord.findById('1');
      record.set({ name: 'Bob' });
      await record.save();

      expect(record.data.name).toBe('Bob');
      expect(record.data).toEqual(updatedRow);
    });

    it('no-ops for clean persisted records', async () => {
      const row = { id: '1', name: 'Alice', email: 'a@test.com', active: true };
      mockDelegate.findFirst.mockResolvedValue(row);

      const record = await TestRecord.findById('1');
      await record.save();

      expect(mockDelegate.update).not.toHaveBeenCalled();
      expect(mockDelegate.create).not.toHaveBeenCalled();
    });

    it('skips the DB update when set() is called with an empty patch', async () => {
      const row = { id: '1', name: 'Alice', email: 'a@test.com', active: true };
      mockDelegate.findFirst.mockResolvedValue(row);

      const record = await TestRecord.findById('1');
      record.set({});
      await record.save();

      expect(record.isDirty).toBe(false);
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });

    it('treats explicit undefined as a tracked-but-DB-skipped field', async () => {
      const row = { id: '1', name: 'Alice', email: 'a@test.com', active: true };
      mockDelegate.findFirst.mockResolvedValue(row);
      mockDelegate.update.mockResolvedValue(row);

      const record = await TestRecord.findById('1');
      record.set({ name: undefined });
      expect(record.isDirty).toBe(true);

      await record.save();

      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: '1' },
        data: { name: undefined },
      });
    });
  });

  describe('delete', () => {
    it('throws on non-persisted records', async () => {
      const record = TestRecord.build({ id: '1', name: 'Alice', email: 'a@test.com', active: true });
      await expect(record.delete()).rejects.toThrow('Only persisted records can be deleted.');
    });

    it('hard-deletes (physical DELETE) when no softDeleteField is configured', async () => {
      const row = { id: '1', name: 'Alice', email: 'a@test.com', active: true };
      mockDelegate.findFirst.mockResolvedValue(row);
      mockDelegate.delete.mockResolvedValue(row);

      const record = await TestRecord.findById('1');
      await record.delete();

      expect(record.isDeleted).toBe(true);
      expect(mockDelegate.delete).toHaveBeenCalledWith({ where: { id: '1' } });
      expect(mockDelegate.update).not.toHaveBeenCalled();
    });
  });

  describe('static finders', () => {
    it('findById returns null when row not found', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      const result = await TestRecord.findById('nonexistent');
      expect(result).toBeNull();
    });

    it('findById returns a persisted record', async () => {
      const row = { id: '1', name: 'Alice', email: 'a@test.com', active: true };
      mockDelegate.findFirst.mockResolvedValue(row);

      const record = await TestRecord.findById('1');
      expect(record).not.toBeNull();
      expect(record.state).toBe('persisted');
      expect(record.data.name).toBe('Alice');
    });

    it('findById routes through findFirst (not findUnique)', async () => {
      const row = { id: '1', name: 'Alice', email: 'a@test.com', active: true };
      mockDelegate.findFirst.mockResolvedValue(row);

      await TestRecord.findById('1');

      expect(mockDelegate.findFirst).toHaveBeenCalledWith({ where: { id: '1' } });
      expect(mockDelegate.findUnique).not.toHaveBeenCalled();
    });

    it('findOne passes args through and returns record', async () => {
      const row = { id: '1', name: 'Alice', email: 'a@test.com', active: true };
      mockDelegate.findFirst.mockResolvedValue(row);

      const record = await TestRecord.findOne({ where: { email: 'a@test.com' } });
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({ where: { email: 'a@test.com' } });
      expect(record.data.email).toBe('a@test.com');
    });

    it('findMany returns an array of records', async () => {
      const rows = [
        { id: '1', name: 'Alice', email: 'a@test.com', active: true },
        { id: '2', name: 'Bob', email: 'b@test.com', active: false },
      ];
      mockDelegate.findMany.mockResolvedValue(rows);

      const records = await TestRecord.findMany();
      expect(records).toHaveLength(2);
      expect(records[0].data.name).toBe('Alice');
      expect(records[1].data.name).toBe('Bob');
    });
  });

  describe('toJSON', () => {
    it('returns current data', () => {
      const record = TestRecord.build({ id: '1', name: 'Alice', email: 'a@test.com', active: true });
      expect(record.toJSON()).toEqual({ id: '1', name: 'Alice', email: 'a@test.com', active: true });
    });
  });

  describe('subclass methods', () => {
    it('rename method uses set and is chainable', () => {
      const record = TestRecord.build({ id: '1', name: 'Alice', email: 'a@test.com', active: true });
      const result = record.rename('Bob');
      expect(result).toBe(record);
      expect(record.data.name).toBe('Bob');
      expect(record.isDirty).toBe(true);
    });
  });

  describe('_scopeWhere', () => {
    it('save uses _scopeWhere for update WHERE clause', async () => {
      const row = { id: '1', name: 'Alice', organizationId: 'org-1' };
      mockDelegate.findFirst.mockResolvedValue(row);
      mockDelegate.update.mockResolvedValue({ ...row, name: 'Bob' });

      const record = await TenantScopedRecord.findOne({ where: { id: '1' } });
      record.set({ name: 'Bob' });
      await record.save();

      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: '1', organizationId: 'org-1' },
        data: { name: 'Bob' },
      });
    });

    it('delete uses _scopeWhere for delete WHERE clause', async () => {
      const row = { id: '1', name: 'Alice', organizationId: 'org-1' };
      mockDelegate.findFirst.mockResolvedValue(row);
      mockDelegate.delete.mockResolvedValue(row);

      const record = await TenantScopedRecord.findOne({ where: { id: '1' } });
      await record.delete();

      expect(mockDelegate.delete).toHaveBeenCalledWith({
        where: { id: '1', organizationId: 'org-1' },
      });
    });

    it('default _scopeWhere uses only id', async () => {
      const row = { id: '1', name: 'Alice', email: 'a@test.com', active: true };
      mockDelegate.findFirst.mockResolvedValue(row);
      mockDelegate.update.mockResolvedValue({ ...row, name: 'Bob' });

      const record = await TestRecord.findById('1');
      record.set({ name: 'Bob' });
      await record.save();

      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: '1' },
        data: { name: 'Bob' },
      });
    });
  });

  describe('policy tenantField — automatic tenant scoping', () => {
    describe('with request context bound', () => {
      beforeEach(() => {
        ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, () => ({
          organizationId: 'org-1',
          permissions: new Set<string>(),
        }));
      });

      it('injects tenant scope on the findFirst call that backs findById', async () => {
        mockDelegate.findFirst.mockResolvedValue(null);
        await PolicyScopedRecord.findById('rec-1');

        expect(mockDelegate.findFirst).toHaveBeenCalledWith({
          where: { id: 'rec-1', organizationId: 'org-1' },
        });
      });

      it('injects tenant scope on findFirst', async () => {
        mockDelegate.findFirst.mockResolvedValue(null);
        await PolicyScopedRecord.findOne({ where: { name: 'Alice' } });

        expect(mockDelegate.findFirst).toHaveBeenCalledWith({
          where: { name: 'Alice', organizationId: 'org-1' },
        });
      });

      it('injects tenant scope on findMany (no args)', async () => {
        mockDelegate.findMany.mockResolvedValue([]);
        await PolicyScopedRecord.findMany();

        expect(mockDelegate.findMany).toHaveBeenCalledWith({
          where: { organizationId: 'org-1' },
        });
      });

      it('injects tenant scope on findMany (with args)', async () => {
        mockDelegate.findMany.mockResolvedValue([]);
        await PolicyScopedRecord.findMany({ where: { name: 'Alice' }, orderBy: { name: 'asc' } });

        expect(mockDelegate.findMany).toHaveBeenCalledWith({
          where: { name: 'Alice', organizationId: 'org-1' },
          orderBy: { name: 'asc' },
        });
      });

      it('overrides an explicit tenantField with ctx.org (strict tenant lock)', async () => {
        mockDelegate.findMany.mockResolvedValue([]);
        await PolicyScopedRecord.findMany({ where: { organizationId: 'org-2' } });

        expect(mockDelegate.findMany).toHaveBeenCalledWith({
          where: { organizationId: 'org-1' },
        });
      });

      it('overrides explicit `organizationId: null` with ctx.org (no platform-row leak)', async () => {
        mockDelegate.findMany.mockResolvedValue([]);
        await PolicyScopedRecord.findMany({ where: { organizationId: null } });

        expect(mockDelegate.findMany).toHaveBeenCalledWith({
          where: { organizationId: 'org-1' },
        });
      });

      it('overrides explicit `organizationId: undefined` with ctx.org (no all-rows leak)', async () => {
        mockDelegate.findMany.mockResolvedValue([]);
        await PolicyScopedRecord.findMany({ where: { organizationId: undefined } });

        expect(mockDelegate.findMany).toHaveBeenCalledWith({
          where: { organizationId: 'org-1' },
        });
      });

      it('overrides explicit tenantField alongside sibling filters (keeps siblings, pins org)', async () => {
        mockDelegate.findMany.mockResolvedValue([]);
        await PolicyScopedRecord.findMany({
          where: { name: 'Alice', organizationId: 'org-2' },
          orderBy: { name: 'asc' },
        });

        expect(mockDelegate.findMany).toHaveBeenCalledWith({
          where: { name: 'Alice', organizationId: 'org-1' },
          orderBy: { name: 'asc' },
        });
      });

      it('build() auto-fills tenantField from context', async () => {
        mockDelegate.create.mockResolvedValue({ id: '1', name: 'Alice', organizationId: 'org-1' });

        const record = PolicyScopedRecord.build({ name: 'Alice' });
        expect(record.data.organizationId).toBe('org-1');

        await record.save();
        expect(mockDelegate.create).toHaveBeenCalledWith({
          data: { name: 'Alice', organizationId: 'org-1' },
        });
      });

      it('build() does not overwrite an explicit tenantField', () => {
        const record = PolicyScopedRecord.build({ name: 'Alice', organizationId: 'org-2' });
        expect(record.data.organizationId).toBe('org-2');
      });

      it('_scopeWhere() pulls tenantField from the record data on update', async () => {
        mockDelegate.findFirst.mockResolvedValue({ id: '1', name: 'Alice', organizationId: 'org-1' });
        mockDelegate.update.mockResolvedValue({ id: '1', name: 'Bob', organizationId: 'org-1' });

        const record = await PolicyScopedRecord.findOne({ where: { id: '1' } });
        record.set({ name: 'Bob' });
        await record.save();

        expect(mockDelegate.update).toHaveBeenCalledWith({
          where: { id: '1', organizationId: 'org-1' },
          data: { name: 'Bob' },
        });
      });

      it('_scopeWhere() pulls tenantField from the record data on delete', async () => {
        mockDelegate.findFirst.mockResolvedValue({ id: '1', name: 'Alice', organizationId: 'org-1' });
        mockDelegate.delete.mockResolvedValue({ id: '1', name: 'Alice', organizationId: 'org-1' });

        const record = await PolicyScopedRecord.findOne({ where: { id: '1' } });
        await record.delete();

        expect(mockDelegate.delete).toHaveBeenCalledWith({
          where: { id: '1', organizationId: 'org-1' },
        });
      });

      it('_unscopedDelegate() does NOT inject tenantField', async () => {
        mockDelegate.findMany.mockResolvedValue([]);
        await PolicyScopedRecord._unscopedDelegate().findMany({ where: { name: 'Alice' } });

        expect(mockDelegate.findMany).toHaveBeenCalledWith({ where: { name: 'Alice' } });
      });

      it('injects tenant scope on findUniqueOrThrow via _delegate()', async () => {
        mockDelegate.findUniqueOrThrow.mockResolvedValue(null);
        await PolicyScopedRecord._delegate().findUniqueOrThrow({ where: { id: 'rec-1' } });

        expect(mockDelegate.findUniqueOrThrow).toHaveBeenCalledWith({
          where: { id: 'rec-1', organizationId: 'org-1' },
        });
      });

      it('injects tenant scope on findFirstOrThrow via _delegate()', async () => {
        mockDelegate.findFirstOrThrow.mockResolvedValue(null);
        await PolicyScopedRecord._delegate().findFirstOrThrow({ where: { name: 'Alice' } });

        expect(mockDelegate.findFirstOrThrow).toHaveBeenCalledWith({
          where: { name: 'Alice', organizationId: 'org-1' },
        });
      });

      it('injects tenant scope on count via _delegate()', async () => {
        mockDelegate.count.mockResolvedValue(0);
        await PolicyScopedRecord._delegate().count({ where: { name: 'Alice' } });

        expect(mockDelegate.count).toHaveBeenCalledWith({
          where: { name: 'Alice', organizationId: 'org-1' },
        });
      });

      it('injects tenant scope on count with no args', async () => {
        mockDelegate.count.mockResolvedValue(0);
        await PolicyScopedRecord._delegate().count();

        expect(mockDelegate.count).toHaveBeenCalledWith({
          where: { organizationId: 'org-1' },
        });
      });

      it('injects tenant scope on aggregate via _delegate()', async () => {
        mockDelegate.aggregate.mockResolvedValue({});
        await PolicyScopedRecord._delegate().aggregate({
          where: { name: 'Alice' },
          _count: { _all: true },
        });

        expect(mockDelegate.aggregate).toHaveBeenCalledWith({
          where: { name: 'Alice', organizationId: 'org-1' },
          _count: { _all: true },
        });
      });

      it('injects tenant scope on groupBy via _delegate()', async () => {
        mockDelegate.groupBy.mockResolvedValue([]);
        await PolicyScopedRecord._delegate().groupBy({
          by: ['name'],
          where: { name: 'Alice' },
        });

        expect(mockDelegate.groupBy).toHaveBeenCalledWith({
          by: ['name'],
          where: { name: 'Alice', organizationId: 'org-1' },
        });
      });

      it('overrides an explicit tenantField on count where with ctx.org', async () => {
        mockDelegate.count.mockResolvedValue(0);
        await PolicyScopedRecord._delegate().count({ where: { organizationId: 'org-2' } });

        expect(mockDelegate.count).toHaveBeenCalledWith({
          where: { organizationId: 'org-1' },
        });
      });

      it('does NOT inject tenant scope on single-row writes via _delegate() (writes go through _scopeWhere)', async () => {
        mockDelegate.create.mockResolvedValue({});
        mockDelegate.update.mockResolvedValue({});
        mockDelegate.delete.mockResolvedValue({});

        const delegate = PolicyScopedRecord._delegate();
        await delegate.create({ data: { name: 'Alice' } });
        await delegate.update({ where: { id: '1' }, data: { name: 'Bob' } });
        await delegate.delete({ where: { id: '1' } });

        expect(mockDelegate.create).toHaveBeenCalledWith({ data: { name: 'Alice' } });
        expect(mockDelegate.update).toHaveBeenCalledWith({ where: { id: '1' }, data: { name: 'Bob' } });
        expect(mockDelegate.delete).toHaveBeenCalledWith({ where: { id: '1' } });
      });

      it.each(['updateMany', 'deleteMany', 'createMany', 'upsert'] as const)(
        '_delegate().%s() refuses (never runs unscoped) and points to the raw client',
        async (method) => {
          const delegate = PolicyScopedRecord._delegate() as unknown as Record<
            string,
            (args: object) => Promise<unknown>
          >;
          await expect(delegate[method]({ where: {}, data: {} })).rejects.toThrow(
            /not tenant-scoped.*ActiveRecordRegistry\.client/s,
          );
          expect(mockDelegate[method]).not.toHaveBeenCalled();
        },
      );

      it('findByIdUnscoped bypasses tenantField injection and wraps the row in a record', async () => {
        const row = { id: 'rec-1', name: 'Alice', organizationId: 'org-other' };
        mockDelegate.findUnique.mockResolvedValue(row);

        const record = await PolicyScopedRecord.findByIdUnscoped('rec-1');

        expect(mockDelegate.findUnique).toHaveBeenCalledWith({ where: { id: 'rec-1' } });
        expect(record).not.toBeNull();
        expect(record.data.organizationId).toBe('org-other');
        expect(record.isPersisted).toBe(true);
      });

      it('findByIdUnscoped returns null when row is missing', async () => {
        mockDelegate.findUnique.mockResolvedValue(null);
        const result = await PolicyScopedRecord.findByIdUnscoped('missing');
        expect(result).toBeNull();
      });

      it('findOneUnscoped bypasses tenantField injection and passes args through', async () => {
        const row = { id: 'rec-1', name: 'Alice', organizationId: 'org-other' };
        mockDelegate.findFirst.mockResolvedValue(row);

        const record = await PolicyScopedRecord.findOneUnscoped({
          where: { customerId: 'cust-1', name: 'Alice' },
        });

        expect(mockDelegate.findFirst).toHaveBeenCalledWith({
          where: { customerId: 'cust-1', name: 'Alice' },
        });
        expect(record.data.organizationId).toBe('org-other');
      });

      it('findManyUnscoped bypasses tenantField injection and wraps rows', async () => {
        const rows = [
          { id: '1', name: 'Alice', organizationId: 'org-1' },
          { id: '2', name: 'Bob', organizationId: 'org-2' },
        ];
        mockDelegate.findMany.mockResolvedValue(rows);

        const records = await PolicyScopedRecord.findManyUnscoped({ orderBy: { name: 'asc' } });

        expect(mockDelegate.findMany).toHaveBeenCalledWith({ orderBy: { name: 'asc' } });
        expect(records).toHaveLength(2);
        expect(records.map((r) => r.data.organizationId)).toEqual(['org-1', 'org-2']);
      });

      it('findManyUnscoped with no args still bypasses tenantField injection', async () => {
        mockDelegate.findMany.mockResolvedValue([]);
        await PolicyScopedRecord.findManyUnscoped();
        expect(mockDelegate.findMany).toHaveBeenCalledWith({});
      });
    });

    describe('with no request context — strict mode throws', () => {
      beforeEach(() => {
        ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, () => undefined);
      });

      it('findById throws TenantContextRequiredError', async () => {
        await expect(PolicyScopedRecord.findById('rec-1')).rejects.toThrow(TenantContextRequiredError);
        expect(mockDelegate.findFirst).not.toHaveBeenCalled();
        expect(mockDelegate.findUnique).not.toHaveBeenCalled();
      });

      it('findMany throws TenantContextRequiredError', async () => {
        await expect(PolicyScopedRecord.findMany({ where: { name: 'Alice' } })).rejects.toThrow(
          TenantContextRequiredError,
        );
        expect(mockDelegate.findMany).not.toHaveBeenCalled();
      });

      it('count, aggregate, and groupBy all throw TenantContextRequiredError', async () => {
        const delegate = PolicyScopedRecord._delegate();
        await expect(delegate.count({ where: { name: 'Alice' } })).rejects.toThrow(TenantContextRequiredError);
        await expect(delegate.aggregate({ where: { name: 'Alice' }, _count: { _all: true } })).rejects.toThrow(
          TenantContextRequiredError,
        );
        await expect(delegate.groupBy({ by: ['name'], where: { name: 'Alice' } })).rejects.toThrow(
          TenantContextRequiredError,
        );

        expect(mockDelegate.count).not.toHaveBeenCalled();
        expect(mockDelegate.aggregate).not.toHaveBeenCalled();
        expect(mockDelegate.groupBy).not.toHaveBeenCalled();
      });

      it('explicit tenant value in the where clause is honored (no throw)', async () => {
        mockDelegate.findMany.mockResolvedValue([]);
        await PolicyScopedRecord.findMany({ where: { name: 'Alice', organizationId: 'org-explicit' } });

        expect(mockDelegate.findMany).toHaveBeenCalledWith({
          where: { name: 'Alice', organizationId: 'org-explicit' },
        });
      });

      it('explicit `organizationId: undefined` throws (would drop the filter and read unscoped)', async () => {
        await expect(PolicyScopedRecord.findMany({ where: { organizationId: undefined } })).rejects.toThrow(
          TenantContextRequiredError,
        );
        expect(mockDelegate.findMany).not.toHaveBeenCalled();
      });

      it('explicit `organizationId: null` is honored (no throw)', async () => {
        mockDelegate.findMany.mockResolvedValue([]);
        await PolicyScopedRecord.findMany({ where: { organizationId: null } });

        expect(mockDelegate.findMany).toHaveBeenCalledWith({
          where: { organizationId: null },
        });
      });

      it('build() throws TenantContextRequiredError when no tenant value supplied', () => {
        expect(() => PolicyScopedRecord.build({ name: 'Alice' })).toThrow(TenantContextRequiredError);
      });

      it('build() with explicit tenant value works without ctx', () => {
        const record = PolicyScopedRecord.build({ name: 'Alice', organizationId: 'org-explicit' });
        expect(record.data.organizationId).toBe('org-explicit');
      });
    });

    describe('save / delete bypass the scoped proxy', () => {
      beforeEach(() => {
        ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, () => ({
          organizationId: 'org-1',
          permissions: new Set<string>(),
        }));
      });

      it('save() does not call _delegate() (which would allocate a Proxy)', async () => {
        const scopedSpy = vi.spyOn(PolicyScopedRecord, '_delegate');
        const unscopedSpy = vi.spyOn(PolicyScopedRecord, '_unscopedDelegate');
        mockDelegate.findFirst.mockResolvedValue({ id: '1', name: 'Alice', organizationId: 'org-1' });
        mockDelegate.update.mockResolvedValue({ id: '1', name: 'Bob', organizationId: 'org-1' });

        const record = await PolicyScopedRecord.findOne({ where: { id: '1' } });
        scopedSpy.mockClear();
        unscopedSpy.mockClear();

        record.set({ name: 'Bob' });
        await record.save();

        expect(scopedSpy).not.toHaveBeenCalled();
        expect(unscopedSpy).toHaveBeenCalledTimes(1);
      });

      it('delete() does not call _delegate() (which would allocate a Proxy)', async () => {
        const scopedSpy = vi.spyOn(PolicyScopedRecord, '_delegate');
        const unscopedSpy = vi.spyOn(PolicyScopedRecord, '_unscopedDelegate');
        mockDelegate.findFirst.mockResolvedValue({ id: '1', name: 'Alice', organizationId: 'org-1' });
        mockDelegate.delete.mockResolvedValue({});

        const record = await PolicyScopedRecord.findOne({ where: { id: '1' } });
        scopedSpy.mockClear();
        unscopedSpy.mockClear();

        await record.delete();

        expect(scopedSpy).not.toHaveBeenCalled();
        expect(unscopedSpy).toHaveBeenCalledTimes(1);
      });

      it('save() still scopes the UPDATE WHERE by tenant (via _scopeWhere)', async () => {
        mockDelegate.findFirst.mockResolvedValue({ id: '1', name: 'Alice', organizationId: 'org-1' });
        mockDelegate.update.mockResolvedValue({ id: '1', name: 'Bob', organizationId: 'org-1' });

        const record = await PolicyScopedRecord.findOne({ where: { id: '1' } });
        record.set({ name: 'Bob' });
        await record.save();

        expect(mockDelegate.update).toHaveBeenCalledWith({
          where: { id: '1', organizationId: 'org-1' },
          data: { name: 'Bob' },
        });
      });

      it('delete() still scopes the DELETE WHERE by tenant (via _scopeWhere)', async () => {
        mockDelegate.findFirst.mockResolvedValue({ id: '1', name: 'Alice', organizationId: 'org-1' });
        mockDelegate.delete.mockResolvedValue({});

        const record = await PolicyScopedRecord.findOne({ where: { id: '1' } });
        await record.delete();

        expect(mockDelegate.delete).toHaveBeenCalledWith({
          where: { id: '1', organizationId: 'org-1' },
        });
      });

      it('save() on a new record creates without proxy interception (no context override on tenant)', async () => {
        mockDelegate.create.mockResolvedValue({ id: 'gen', name: 'Alice', organizationId: 'org-1' });

        const record = PolicyScopedRecord.build({ name: 'Alice' });
        await record.save();

        expect(mockDelegate.create).toHaveBeenCalledWith({
          data: { name: 'Alice', organizationId: 'org-1' },
        });
      });
    });

    describe('with no context provider configured', () => {
      beforeEach(() => {
        ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, null);
      });

      it('findMany throws TenantContextRequiredError', async () => {
        await expect(PolicyScopedRecord.findMany({ where: { name: 'Alice' } })).rejects.toThrow(
          TenantContextRequiredError,
        );
        expect(mockDelegate.findMany).not.toHaveBeenCalled();
      });
    });

    describe('relation-path tenantField (parent-scoped records)', () => {
      const ParentScopedSchema = z.object({
        id: z.string(),
        name: z.string(),
        parentId: z.string(),
      });
      class ParentScopedRecord extends createActiveRecord(ParentScopedSchema, 'testModel', {
        tenantField: 'parent.organizationId',
      }) {}

      describe('with request context bound', () => {
        beforeEach(() => {
          ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, () => ({
            organizationId: 'org-1',
            permissions: new Set<string>(),
          }));
        });

        it('nests the tenant filter under the relation key', async () => {
          mockDelegate.findMany.mockResolvedValue([]);
          await ParentScopedRecord.findMany();

          expect(mockDelegate.findMany).toHaveBeenCalledWith({
            where: { parent: { organizationId: 'org-1' } },
          });
        });

        it('preserves a co-existing relation filter and adds the tenant leaf alongside it', async () => {
          mockDelegate.findMany.mockResolvedValue([]);
          await ParentScopedRecord.findMany({ where: { parent: { name: 'foo' } } });

          expect(mockDelegate.findMany).toHaveBeenCalledWith({
            where: { parent: { name: 'foo', organizationId: 'org-1' } },
          });
        });

        it('layers with sibling fields on the top-level where', async () => {
          mockDelegate.findMany.mockResolvedValue([]);
          await ParentScopedRecord.findMany({ where: { name: 'Alice', parentId: 'p-1' } });

          expect(mockDelegate.findMany).toHaveBeenCalledWith({
            where: { name: 'Alice', parentId: 'p-1', parent: { organizationId: 'org-1' } },
          });
        });

        it('overrides an explicit value at the relation leaf with ctx.org', async () => {
          mockDelegate.findMany.mockResolvedValue([]);
          await ParentScopedRecord.findMany({ where: { parent: { organizationId: 'org-2' } } });

          expect(mockDelegate.findMany).toHaveBeenCalledWith({
            where: { parent: { organizationId: 'org-1' } },
          });
        });

        it('overrides explicit `null` at the relation leaf with ctx.org (no platform-parent leak)', async () => {
          mockDelegate.findMany.mockResolvedValue([]);
          await ParentScopedRecord.findMany({ where: { parent: { organizationId: null } } });

          expect(mockDelegate.findMany).toHaveBeenCalledWith({
            where: { parent: { organizationId: 'org-1' } },
          });
        });

        it('overrides at the relation leaf while preserving sibling parent filters', async () => {
          mockDelegate.findMany.mockResolvedValue([]);
          await ParentScopedRecord.findMany({
            where: { parent: { name: 'foo', organizationId: 'org-2' } },
          });

          expect(mockDelegate.findMany).toHaveBeenCalledWith({
            where: { parent: { name: 'foo', organizationId: 'org-1' } },
          });
        });

        it('injects on findFirst via the inherited findById helper (NOT findUnique)', async () => {
          mockDelegate.findFirst.mockResolvedValue(null);
          await ParentScopedRecord.findById('rec-1');

          expect(mockDelegate.findFirst).toHaveBeenCalledWith({
            where: { id: 'rec-1', parent: { organizationId: 'org-1' } },
          });
          expect(mockDelegate.findUnique).not.toHaveBeenCalled();
        });
      });

      describe('without request context bound', () => {
        beforeEach(() => {
          ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, null);
        });

        it('throws TenantContextRequiredError when no explicit tenant value is supplied', async () => {
          await expect(ParentScopedRecord.findMany()).rejects.toThrow(TenantContextRequiredError);
          expect(mockDelegate.findMany).not.toHaveBeenCalled();
        });

        it('proceeds when caller supplies an explicit value at the path (admin-style usage)', async () => {
          mockDelegate.findMany.mockResolvedValue([]);
          await ParentScopedRecord.findMany({ where: { parent: { organizationId: 'org-explicit' } } });

          expect(mockDelegate.findMany).toHaveBeenCalledWith({
            where: { parent: { organizationId: 'org-explicit' } },
          });
        });

        it('throws when the relation-path leaf is explicit `undefined` (would read unscoped)', async () => {
          await expect(
            ParentScopedRecord.findMany({ where: { parent: { organizationId: undefined } } }),
          ).rejects.toThrow(TenantContextRequiredError);
          expect(mockDelegate.findMany).not.toHaveBeenCalled();
        });
      });

      describe('build() and _scopeWhere() with relation-path policy', () => {
        beforeEach(() => {
          ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, () => ({
            organizationId: 'org-1',
            permissions: new Set<string>(),
          }));
        });

        it('build() does NOT inject a literal dotted column name (would corrupt data)', () => {
          const record = ParentScopedRecord.build({ name: 'x', parentId: 'p-1' });
          const data = record.data as Record<string, unknown>;
          expect(data).not.toHaveProperty('parent.organizationId');
          expect(data).not.toHaveProperty('parent');
          expect(data.name).toBe('x');
          expect(data.parentId).toBe('p-1');
        });

        it("build() succeeds without ctx (relation-path doesn't auto-fill, so no ctx required)", () => {
          ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, null);
          expect(() => ParentScopedRecord.build({ name: 'x', parentId: 'p-1' })).not.toThrow();
        });

        it('save() on a relation-scoped record expands the dotted path as a nested relation filter in update WHERE', async () => {
          mockDelegate.update.mockResolvedValue({ id: 'rec-1', name: 'Renamed', parentId: 'p-1' });
          const record = ParentScopedRecord.fromRow({ id: 'rec-1', name: 'Alice', parentId: 'p-1' });
          record.set({ name: 'Renamed' });
          await record.save();

          expect(mockDelegate.update).toHaveBeenCalledWith({
            where: { id: 'rec-1', parent: { organizationId: 'org-1' } },
            data: { name: 'Renamed' },
          });
        });

        it('delete() on a relation-scoped record expands the dotted path as a nested relation filter in delete WHERE', async () => {
          mockDelegate.delete.mockResolvedValue({});
          const record = ParentScopedRecord.fromRow({ id: 'rec-1', name: 'Alice', parentId: 'p-1' });
          await record.delete();

          expect(mockDelegate.delete).toHaveBeenCalledWith({
            where: { id: 'rec-1', parent: { organizationId: 'org-1' } },
          });
        });
      });

      describe('save() / delete() without request context bound', () => {
        beforeEach(() => {
          ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, null);
        });

        it('save() falls back to { id }-only WHERE when no ctx is bound', async () => {
          mockDelegate.update.mockResolvedValue({ id: 'rec-1', name: 'Renamed', parentId: 'p-1' });
          const record = ParentScopedRecord.fromRow({ id: 'rec-1', name: 'Alice', parentId: 'p-1' });
          record.set({ name: 'Renamed' });
          await record.save();

          expect(mockDelegate.update).toHaveBeenCalledWith({
            where: { id: 'rec-1' },
            data: { name: 'Renamed' },
          });
        });

        it('delete() falls back to { id }-only WHERE when no ctx is bound', async () => {
          mockDelegate.delete.mockResolvedValue({});
          const record = ParentScopedRecord.fromRow({ id: 'rec-1', name: 'Alice', parentId: 'p-1' });
          await record.delete();

          expect(mockDelegate.delete).toHaveBeenCalledWith({ where: { id: 'rec-1' } });
        });
      });
    });
  });
});

describe('policy actions — permission gate (checkPermission)', () => {
  afterEach(() => {
    ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, null);
  });

  it('throws PermissionContextRequiredError with no context (fail closed)', () => {
    ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, null);
    expect(() => GatedRecord.requireAction('archive')).toThrow(PermissionContextRequiredError);
  });

  it('allows under an explicit system context', () => {
    ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, () => ({
      organizationId: 'org-1',
      system: true,
    }));
    expect(() => GatedRecord.requireAction('archive')).not.toThrow();
  });

  it('allows a caller holding the permission', () => {
    ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, () => ({
      organizationId: 'org-1',
      permissions: new Set(['widget:archive']),
    }));
    expect(() => GatedRecord.requireAction('archive')).not.toThrow();
  });

  it('throws ForbiddenException for a caller missing the permission', () => {
    ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, () => ({
      organizationId: 'org-1',
      permissions: new Set<string>(),
    }));
    expect(() => GatedRecord.requireAction('archive')).toThrow(ForbiddenException);
  });
});

describe('policy proxy — identity across chains', () => {
  beforeEach(() => {
    ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, () => ({
      organizationId: 'org-1',
      permissions: new Set(['widget:archive']),
    }));
  });

  afterEach(() => {
    ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, null);
  });

  it('awaited save() resolves to the proxy, not the unwrapped target', async () => {
    mockDelegate.findFirst.mockResolvedValue({ id: '1', name: 'Alice', organizationId: 'org-1' });
    mockDelegate.update.mockResolvedValue({ id: '1', name: 'Bob', organizationId: 'org-1' });

    const record = await GatedRecord.findOne({ where: { id: '1' } });
    record.set({ name: 'Bob' });
    const saved = await record.save();

    expect(saved).toBe(record);
  });
});
