import { Prisma } from '@repo/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ActiveRecordRegistry } from '../active-record.registry';
import { RecordNotFoundError } from '../active-record.types';
import { createActiveRecord } from '../create-active-record';


const mockDelegate = {
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

const Schema = z.object({ id: z.string(), name: z.string(), organizationId: z.string() });

class SoftDeleteRecord extends createActiveRecord(Schema.extend({ deletedAt: z.date().nullable() }), 'testModel', {
  tenantField: 'organizationId',
  softDeleteField: 'deletedAt',
}) {}

class HardDeleteRecord extends createActiveRecord(Schema, 'testModel', {
  tenantField: 'organizationId',
}) {}

const knownError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError(`mock ${code}`, { code, clientVersion: 'test' });

describe('write-side tenant isolation: P2025 → RecordNotFoundError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, () => ({
      organizationId: 'org-1',
      permissions: new Set<string>(),
    }));
  });

  it('save-update: a zero-row match (P2025) rejects as RecordNotFoundError carrying model/recordId', async () => {
    const rec = HardDeleteRecord.fromRow({ id: 'rec-1', name: 'A', organizationId: 'org-1' });
    rec.set({ name: 'B' });
    mockDelegate.update.mockRejectedValue(knownError('P2025'));

    const err = await rec.save().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecordNotFoundError);
    expect(err).toMatchObject({ model: 'testModel', recordId: 'rec-1' });
    expect(mockDelegate.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rec-1', organizationId: 'org-1' } }),
    );
  });

  it('soft-delete update: P2025 rejects as RecordNotFoundError', async () => {
    const rec = SoftDeleteRecord.fromRow({ id: 'rec-2', name: 'A', organizationId: 'org-1', deletedAt: null });
    mockDelegate.update.mockRejectedValue(knownError('P2025'));

    const err = await rec.delete().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecordNotFoundError);
    expect(err).toMatchObject({ model: 'testModel', recordId: 'rec-2' });
  });

  it('hard-delete: P2025 from delete rejects as RecordNotFoundError', async () => {
    const rec = HardDeleteRecord.fromRow({ id: 'rec-3', name: 'A', organizationId: 'org-1' });
    mockDelegate.delete.mockRejectedValue(knownError('P2025'));

    const err = await rec.delete().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecordNotFoundError);
    expect(err).toMatchObject({ model: 'testModel', recordId: 'rec-3' });
  });

  it('a non-P2025 known error is re-thrown unchanged (catch is not over-broad)', async () => {
    const rec = HardDeleteRecord.fromRow({ id: 'rec-4', name: 'A', organizationId: 'org-1' });
    rec.set({ name: 'B' });
    mockDelegate.update.mockRejectedValue(knownError('P2002'));

    const err = await rec.save().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(err).not.toBeInstanceOf(RecordNotFoundError);
    expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  });
});
