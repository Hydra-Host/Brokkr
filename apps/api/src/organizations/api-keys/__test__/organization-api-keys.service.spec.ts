import { ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import { OrganizationMembershipRole } from '@repo/database';
import { describe, expect, it, vi } from 'vitest';
import type { ContextService } from '../../../common/context/context.service';
import { OrganizationApiKeysService } from '../organization-api-keys.service';

const { Admin, Member } = OrganizationMembershipRole;

async function expectHttpStatus(p: Promise<unknown>, status: HttpStatus): Promise<void> {
  await p.then(
    () => {
      throw new Error(`expected the call to reject with HTTP ${status}, but it resolved`);
    },
    (err: unknown) => {
      if (!(err instanceof HttpException)) throw err;
      expect(err.getStatus()).toBe(status);
    },
  );
}

function build(
  callerRole: OrganizationMembershipRole,
  actorPermissions: string[] = [],
  ownerPermissions: string[] = actorPermissions,
) {
  const createApiKey = vi.fn().mockResolvedValue({
    id: 'key-1',
    name: 'key',
    referenceId: 'u1',
    enabled: true,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    requestCount: 0,
    metadata: null,
  });
  const deleteApiKey = vi.fn().mockResolvedValue({ success: true });
  const updateApiKey = vi.fn().mockResolvedValue({});

  const ctx = {
    role: callerRole,
    organizationId: 'org-1',
    userId: 'u1',
    user: { name: 'A', email: 'a@example.com' },
    permissions: new Set(actorPermissions),
    requirePermission: vi.fn((resource: string, action: string) => {
      if (callerRole === Member && action !== 'create' && action !== 'read')
        throw new ForbiddenException(`missing ${resource}:${action}`);
    }),
    buildAuditPayload: vi.fn(() => ({ triggeredBy: 'u1', triggeredByEmail: 'a@example.com', organizationId: 'org-1' })),
    pushIntent: vi.fn(() => 'intent-1'),
    finalizeIntents: vi.fn(),
    requestId: 'req-1',
    actorFields: vi.fn(() => ({
      actorType: 'UI',
      actorId: 'u1',
      actorLabel: 'a@example.com',
      apiKeyId: null,
      apiKeyLabel: null,
    })),
    requestFields: vi.fn(() => ({ method: 'POST', path: '/api/v1/api-keys', ipAddress: null, userAgent: null })),
  } as unknown as ContextService;

  const apiKey = {
    update: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
    findUnique: vi.fn().mockResolvedValue({ id: 'key-1', organizationId: 'org-1' }),
  };
  const prisma = {
    apiKey,
    member: {
      findFirst: vi.fn().mockResolvedValue({ assignedRoleId: 'owner-role' }),
    },
    $transaction: vi.fn((fn: (tx: { apiKey: typeof apiKey }) => unknown) => fn({ apiKey })),
  };
  const authClient = { api: { createApiKey, deleteApiKey, updateApiKey } };
  const rbacResolver = {
    resolveEffectivePermissions: vi.fn().mockResolvedValue(new Set(ownerPermissions)),
  };

  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const eventLog = { record: vi.fn().mockResolvedValue(undefined), recordInTransaction: vi.fn().mockResolvedValue(undefined) };

  const service = new OrganizationApiKeysService(
    ctx,
    prisma as never,
    authClient as never,
    rbacResolver as never,
    eventLog as never,
    logger as never,
  );
  return {
    service,
    createApiKey,
    updateApiKey,
    findFirst: prisma.apiKey.findUnique,
    resolveEffectivePermissions: rbacResolver.resolveEffectivePermissions,
    prismaDelete: prisma.apiKey.delete,
    logger,
  };
}

describe('OrganizationApiKeysService role enforcement', () => {
  it('allows a Member creating an API key', async () => {
    const { service, createApiKey } = build(Member, ['device:read']);
    await expect(service.createApiKey({}, { name: 'key' })).resolves.toBeDefined();
    expect(createApiKey).toHaveBeenCalled();
  });

  it('allows an Admin creating an API key', async () => {
    const { service, createApiKey } = build(Admin, ['device:read']);
    await expect(service.createApiKey({}, { name: 'key' })).resolves.toBeDefined();
    expect(createApiKey).toHaveBeenCalled();
  });

  it('audits key creation with the id but NEVER the plaintext key', async () => {
    const { service, createApiKey, logger } = build(Admin, ['device:read']);
    createApiKey.mockResolvedValueOnce({
      id: 'key-audit',
      name: 'ci',
      referenceId: 'u1',
      enabled: true,
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      requestCount: 0,
      metadata: null,
      key: 'brk_PLAINTEXT_SECRET',
    });
    await service.createApiKey({}, { name: 'ci' });
    const logged = logger.log.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(logged).toContain('key-audit');
    expect(logged).not.toContain('brk_PLAINTEXT_SECRET');
  });

  it('rejects a Member deleting an API key', async () => {
    const { service, prismaDelete } = build(Member);
    await expect(service.deleteApiKey('key-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prismaDelete).not.toHaveBeenCalled();
  });

  it('allows an Admin deleting an API key and audits the deleted id', async () => {
    const { service, prismaDelete, logger } = build(Admin);
    await expect(service.deleteApiKey('key-1')).resolves.toEqual({ success: true });
    expect(prismaDelete).toHaveBeenCalledWith({ where: { id: 'key-1' } });
    expect(logger.log.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('key-1');
  });
});

describe('OrganizationApiKeysService per-key permission cap (no self-escalation)', () => {
  it('rejects granting a key a permission the creator does not hold', async () => {
    const { service, createApiKey } = build(Admin, ['device:read']);
    await expect(
      service.createApiKey({}, { name: 'k', permissions: ['device:read', 'device-secret:access'] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it('stores requested permissions as a resource→actions record when within the creator’s set', async () => {
    const { service, createApiKey } = build(Admin, ['device:read', 'device:power-control']);
    await service.createApiKey({}, { name: 'k', permissions: ['device:read', 'device:power-control'] });
    expect(createApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ permissions: { device: ['read', 'power-control'] } }),
      }),
    );
  });

  it('omits stored scope when no permissions are requested', async () => {
    const { service, createApiKey } = build(Admin, ['device:read']);
    const result = await service.createApiKey({}, { name: 'k' });
    expect(createApiKey.mock.calls[0][0].body).not.toHaveProperty('permissions');
    expect(result.permissions).toBeNull();
  });

  it('omits stored scope when an empty selection is submitted', async () => {
    const { service, createApiKey } = build(Admin, ['device:read']);
    await service.createApiKey({}, { name: 'k', permissions: [] });
    expect(createApiKey.mock.calls[0][0].body).not.toHaveProperty('permissions');
  });

  it('converts public expiration milliseconds to Better Auth seconds exactly once', async () => {
    const { service, createApiKey } = build(Admin, ['device:read']);
    await service.createApiKey({}, { name: 'k', expiresIn: 86_400_000 });
    expect(createApiKey.mock.calls[0][0].body.expiresIn).toBe(86_400);
  });

  it('allows dynamic inheritance when the actor currently has no delegable permissions', async () => {
    const { service, createApiKey } = build(Admin, ['api-key:create', 'api-key:delete']);

    await service.createApiKey({}, { name: 'k' });
    expect(createApiKey.mock.calls[0][0].body).not.toHaveProperty('permissions');
  });
});

describe('OrganizationApiKeysService.updateApiKey (edit scope)', () => {
  const richRow = {
    id: 'key-1',
    organizationId: 'org-1',
    userId: 'other-user',
    name: 'k',
    start: null,
    prefix: null,
    enabled: true,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    requestCount: 0,
    remaining: null,
    lastRequest: null,
    metadata: null,
    permissions: null,
    user: { name: 'A', email: 'a@example.com', members: [] },
  };

  it('rejects a Member editing a key (no api-key:update)', async () => {
    const { service, updateApiKey } = build(Member, ['device:read']);
    await expect(service.updateApiKey('key-1', ['device:read'])).rejects.toBeInstanceOf(ForbiddenException);
    expect(updateApiKey).not.toHaveBeenCalled();
  });

  it('404s a key from another org before touching Better Auth', async () => {
    const { service, updateApiKey, findFirst } = build(Admin, ['device:read']);
    findFirst.mockResolvedValueOnce(null);
    await expectHttpStatus(service.updateApiKey('key-other', ['device:read']), HttpStatus.NOT_FOUND);
    expect(updateApiKey).not.toHaveBeenCalled();
  });

  it('allows a cross-user manager to preserve owner permissions the manager does not hold', async () => {
    const { service, updateApiKey, findFirst } = build(Admin, ['api-key:update'], ['device-secret:access']);
    findFirst.mockResolvedValue(richRow);
    await service.updateApiKey('key-1', ['device-secret:access']);
    expect(updateApiKey).toHaveBeenCalledWith({
      body: { keyId: 'key-1', userId: 'other-user', permissions: { 'device-secret': ['access'] } },
    });
  });

  it('rejects a cross-user scope wider than the key owner’s live permissions', async () => {
    const { service, updateApiKey, findFirst } = build(Admin, ['api-key:update'], ['device:read']);
    findFirst.mockResolvedValue(richRow);
    await expect(service.updateApiKey('key-1', ['device-secret:access'])).rejects.toBeInstanceOf(ForbiddenException);
    expect(updateApiKey).not.toHaveBeenCalled();
  });

  it('rejects a scope wider than the key owner’s permissions after delegability checks pass', async () => {
    const { service, updateApiKey, findFirst, resolveEffectivePermissions } = build(
      Admin,
      ['api-key:update', 'device:power-control'],
      ['device:read'],
    );
    findFirst.mockResolvedValue(richRow);
    await expect(service.updateApiKey('key-1', ['device:power-control'])).rejects.toThrow(
      'Cannot grant permissions the key owner does not hold: device:power-control',
    );
    expect(resolveEffectivePermissions).toHaveBeenCalledWith('owner-role');
    expect(updateApiKey).not.toHaveBeenCalled();
  });

  it('writes the new scope as a record when within the editor’s set', async () => {
    const { service, updateApiKey, findFirst } = build(Admin, ['device:read', 'device:power-control']);
    findFirst.mockResolvedValue(richRow);
    await service.updateApiKey('key-1', ['device:read', 'device:power-control']);
    expect(updateApiKey).toHaveBeenCalledWith({
      body: { keyId: 'key-1', userId: 'other-user', permissions: { device: ['read', 'power-control'] } },
    });
  });

  it('restores dynamic inheritance when null is requested', async () => {
    const { service, updateApiKey, findFirst } = build(Admin, ['device:read']);
    findFirst.mockResolvedValue(richRow);
    await service.updateApiKey('key-1', null);
    expect(updateApiKey).toHaveBeenCalledWith({
      body: { keyId: 'key-1', userId: 'other-user', permissions: {} },
    });
  });

  it('restores dynamic inheritance when an empty selection is requested', async () => {
    const { service, updateApiKey, findFirst } = build(Admin, ['api-key:update'], ['device:read']);
    findFirst.mockResolvedValue(richRow);
    await service.updateApiKey('key-1', []);
    expect(updateApiKey).toHaveBeenCalledWith({
      body: { keyId: 'key-1', userId: 'other-user', permissions: {} },
    });
  });

  it('allows dynamic inheritance when the owner currently has no delegable permissions', async () => {
    const { service, updateApiKey, findFirst } = build(Admin, ['device:read'], ['api-key:read']);
    findFirst.mockResolvedValue(richRow);

    await service.updateApiKey('key-1', null);
    expect(updateApiKey).toHaveBeenCalledWith({
      body: { keyId: 'key-1', userId: 'other-user', permissions: {} },
    });
  });
});

describe('OrganizationApiKeysService ownership-based management (manage own without the permission)', () => {
  const ownRow = {
    id: 'key-1',
    organizationId: 'org-1',
    userId: 'u1',
    name: 'k',
    start: null,
    prefix: null,
    enabled: true,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    requestCount: 0,
    remaining: null,
    lastRequest: null,
    metadata: null,
    permissions: null,
    user: { name: 'A', email: 'a@example.com', members: [] },
  };

  it('lets a Member delete their OWN key without holding api-key:delete', async () => {
    const { service, prismaDelete, findFirst } = build(Member);
    findFirst.mockResolvedValue({ id: 'key-1', organizationId: 'org-1', userId: 'u1' });
    await expect(service.deleteApiKey('key-1')).resolves.toEqual({ success: true });
    expect(prismaDelete).toHaveBeenCalledWith({ where: { id: 'key-1' } });
  });

  it('blocks a Member deleting someone else’s key', async () => {
    const { service, prismaDelete, findFirst } = build(Member);
    findFirst.mockResolvedValue({ id: 'key-1', organizationId: 'org-1', userId: 'other-user' });
    await expect(service.deleteApiKey('key-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prismaDelete).not.toHaveBeenCalled();
  });

  it('lets a Member edit their OWN key (still capped at their own permissions)', async () => {
    const { service, updateApiKey, findFirst } = build(Member, ['device:read']);
    findFirst.mockResolvedValue(ownRow);
    await service.updateApiKey('key-1', ['device:read']);
    expect(updateApiKey).toHaveBeenCalled();
  });

  it('blocks an owner from granting their key a permission they do not hold', async () => {
    const { service, updateApiKey, findFirst } = build(Member, ['device:read']);
    findFirst.mockResolvedValue(ownRow);
    await expect(service.updateApiKey('key-1', ['device-secret:access'])).rejects.toBeInstanceOf(ForbiddenException);
    expect(updateApiKey).not.toHaveBeenCalled();
  });

  it('blocks a Member editing someone else’s key', async () => {
    const { service, updateApiKey, findFirst } = build(Member, ['device:read']);
    findFirst.mockResolvedValue({ ...ownRow, userId: 'other-user' });
    await expect(service.updateApiKey('key-1', ['device:read'])).rejects.toBeInstanceOf(ForbiddenException);
    expect(updateApiKey).not.toHaveBeenCalled();
  });
});

describe('OrganizationApiKeysService tenant scoping (IDOR defense)', () => {
  it('getApiKey throws NOT_FOUND for a cross-org key and scopes the lookup by organizationId', async () => {
    const { service, findFirst } = build(Admin);
    findFirst.mockResolvedValueOnce(null);
    await expectHttpStatus(service.getApiKey('key-other'), HttpStatus.NOT_FOUND);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'key-other', organizationId: 'org-1' }) }),
    );
  });

  it('deleteApiKey throws NOT_FOUND for a cross-org key and never deletes the row', async () => {
    const { service, findFirst, prismaDelete } = build(Admin);
    findFirst.mockResolvedValueOnce(null);
    await expectHttpStatus(service.deleteApiKey('key-other'), HttpStatus.NOT_FOUND);
    expect(prismaDelete).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'key-other', organizationId: 'org-1' }) }),
    );
  });
});
