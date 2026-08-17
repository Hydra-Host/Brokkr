import { ForbiddenException } from '@nestjs/common';
import { PermissionContextRequiredError } from '../active-record.types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ActiveRecordRegistry } from '../active-record.registry';
import { createActiveRecord } from '../create-active-record';

const TenantSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string().optional(),
});

const mockDelegate = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  count: vi.fn(),
};

class GatedRecord extends createActiveRecord(TenantSchema, 'testModel', {
  tenantField: 'organizationId',
  actions: { archive: 'widget:archive' },
}) {}

describe('onPermissionCheck', () => {
  afterEach(() => {
    ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, null);
  });

  it('reports a granted policy action as not denied', () => {
    const onPermissionCheck = vi.fn();
    ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, () => ({
      organizationId: 'org-1',
      permissions: new Set(['widget:archive']),
      onPermissionCheck,
    }));

    GatedRecord.requireAction('archive');

    expect(onPermissionCheck).toHaveBeenCalledWith('widget:archive', false);
  });

  it('reports a missing permission as denied before the throw', () => {
    const onPermissionCheck = vi.fn();
    ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, () => ({
      organizationId: 'org-1',
      permissions: new Set<string>(),
      onPermissionCheck,
    }));

    expect(() => GatedRecord.requireAction('archive')).toThrow(ForbiddenException);
    expect(onPermissionCheck).toHaveBeenCalledWith('widget:archive', true);
  });

  it('fires under a system context, before the early return', () => {
    const onPermissionCheck = vi.fn();
    ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, () => ({
      organizationId: 'org-1',
      system: true,
      onPermissionCheck,
    }));

    GatedRecord.requireAction('archive');

    expect(onPermissionCheck).toHaveBeenCalledWith('widget:archive', false);
  });

  it('fails closed before any sink could observe the check', () => {
    ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, null);

    // A spy cannot be asserted here — with no context there is no sink to attach one to,
    // so the only real guarantee is that the gate throws before reaching the callback.
    expect(() => GatedRecord.requireAction('archive')).toThrow(PermissionContextRequiredError);
  });

  it('stays optional so a context without the sink still gates', () => {
    ActiveRecordRegistry.configureForTest({ testModel: mockDelegate }, () => ({
      organizationId: 'org-1',
      permissions: new Set<string>(),
    }));

    expect(() => GatedRecord.requireAction('archive')).toThrow(ForbiddenException);
  });
});
