import { NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { OrganizationInvitationsService } from 'src/organizations/invitations/organization-invitations.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsersService } from '../users.service';

const mockLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe('UsersService.updateUser', () => {
  let service: UsersService;

  const mockPrisma = {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaClient, useValue: mockPrisma },
        { provide: OrganizationInvitationsService, useValue: {} },
        { provide: 'AUTH_SESSION_CACHE', useValue: null },
        { provide: 'LoggerServiceUsersService', useValue: mockLogger },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('updates name fields and composes the display name', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ firstName: 'A', lastName: 'B' });
    mockPrisma.user.update.mockResolvedValue({ id: 'u1' });

    await service.updateUser('u1', { firstName: 'New' });

    const data = mockPrisma.user.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ firstName: 'New', name: 'New B' });
  });

  it('never writes email/emailVerified, even if an email field is passed', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ firstName: 'A', lastName: 'B' });
    mockPrisma.user.update.mockResolvedValue({ id: 'u1' });

    const input = { firstName: 'New', email: 'evil@example.com' };
    await service.updateUser('u1', input);

    expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
    const data = mockPrisma.user.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('email');
    expect(data).not.toHaveProperty('emailVerified');
  });

  it('throws NotFoundException when the user does not exist', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    await expect(service.updateUser('missing', { firstName: 'X' })).rejects.toBeInstanceOf(NotFoundException);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});

describe('UsersService.refreshUserSessions', () => {
  let service: UsersService;

  const mockPrisma = {
    user: { findUnique: vi.fn() },
  };
  const mockCache = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  };

  const buildService = async (cache: unknown) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaClient, useValue: mockPrisma },
        { provide: OrganizationInvitationsService, useValue: {} },
        { provide: 'AUTH_SESSION_CACHE', useValue: cache },
        { provide: 'LoggerServiceUsersService', useValue: mockLogger },
      ],
    }).compile();
    return module.get<UsersService>(UsersService);
  };

  beforeEach(async () => {
    service = await buildService(mockCache);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('is a no-op when no session cache is configured', async () => {
    const noCacheService = await buildService(null);
    await expect(noCacheService.refreshUserSessions('u1')).resolves.toBeUndefined();
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('returns early when the active-sessions list is empty', async () => {
    mockCache.get.mockResolvedValueOnce([]);

    await service.refreshUserSessions('u1');

    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(mockCache.set).not.toHaveBeenCalled();
  });

  it('filters out expired sessions and never re-writes them to cache', async () => {
    const now = Date.now();
    mockCache.get.mockImplementation(async (key: string) => {
      if (key === 'active-sessions-u1') {
        return [
          { token: 'live', expiresAt: now + 60_000 },
          { token: 'expired', expiresAt: now - 60_000 },
        ];
      }
      if (key === 'live') {
        return { session: { expiresAt: new Date(now + 60_000).toISOString() } };
      }
      return null;
    });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com' });

    await service.refreshUserSessions('u1');

    expect(mockCache.get).not.toHaveBeenCalledWith('expired');
    expect(mockCache.set).toHaveBeenCalledTimes(1);
    expect(mockCache.set.mock.calls[0][0]).toBe('live');
  });

  it('skips sessions whose computed ttl is <= 0', async () => {
    const now = Date.now();
    mockCache.get.mockImplementation(async (key: string) => {
      if (key === 'active-sessions-u1') {
        return [{ token: 'stale', expiresAt: now + 60_000 }];
      }
      if (key === 'stale') {
        return { session: { expiresAt: new Date(now - 1_000).toISOString() } };
      }
      return null;
    });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com' });

    await service.refreshUserSessions('u1');

    expect(mockCache.set).not.toHaveBeenCalled();
  });

  it('writes the refreshed user blob with a positive ttl for live sessions', async () => {
    const now = Date.now();
    const user = { id: 'u1', email: 'a@b.com', firstName: 'New' };
    mockCache.get.mockImplementation(async (key: string) => {
      if (key === 'active-sessions-u1') return [{ token: 'live', expiresAt: now + 120_000 }];
      if (key === 'live') return { session: { expiresAt: new Date(now + 120_000).toISOString() } };
      return null;
    });
    mockPrisma.user.findUnique.mockResolvedValue(user);

    await service.refreshUserSessions('u1');

    expect(mockCache.set).toHaveBeenCalledTimes(1);
    const [token, payload, ttl] = mockCache.set.mock.calls[0];
    expect(token).toBe('live');
    expect(JSON.parse(payload as string).user).toEqual(user);
    expect(ttl).toBeGreaterThan(0);
  });

  it('swallows and logs cache get errors instead of throwing', async () => {
    mockCache.get.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.refreshUserSessions('u1')).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('swallows and logs cache set errors instead of throwing', async () => {
    const now = Date.now();
    mockCache.get.mockImplementation(async (key: string) => {
      if (key === 'active-sessions-u1') return [{ token: 'live', expiresAt: now + 120_000 }];
      if (key === 'live') return { session: { expiresAt: new Date(now + 120_000).toISOString() } };
      return null;
    });
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.com' });
    mockCache.set.mockRejectedValueOnce(new Error('write failed'));

    await expect(service.refreshUserSessions('u1')).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalled();
  });
});

describe('UsersService.listPendingInvitationsForUser', () => {
  let service: UsersService;

  const mockPrisma = {
    invitation: { findMany: vi.fn() },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaClient, useValue: mockPrisma },
        { provide: OrganizationInvitationsService, useValue: {} },
        { provide: 'AUTH_SESSION_CACHE', useValue: null },
        { provide: 'LoggerServiceUsersService', useValue: mockLogger },
      ],
    }).compile();
    service = module.get<UsersService>(UsersService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('queries with an expiresAt > now filter so expired pending invites are excluded', async () => {
    mockPrisma.invitation.findMany.mockResolvedValue([]);

    const before = Date.now();
    await service.listPendingInvitationsForUser('user@example.com');
    const after = Date.now();

    const where = mockPrisma.invitation.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('pending');
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
    const cutoff = (where.expiresAt.gt as Date).getTime();
    expect(cutoff).toBeGreaterThanOrEqual(before);
    expect(cutoff).toBeLessThanOrEqual(after);
  });

  it('normalizes lookup email while matching historical mixed-case rows case-insensitively', async () => {
    mockPrisma.invitation.findMany.mockResolvedValue([]);

    await service.listPendingInvitationsForUser(' User@Example.COM ');

    expect(mockPrisma.invitation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          email: { equals: 'user@example.com', mode: 'insensitive' },
        }),
      }),
    );
  });

  it('maps returned invitations to the organization-shaped projection', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const createdAt = new Date();
    mockPrisma.invitation.findMany.mockResolvedValue([
      {
        id: 'inv-1',
        email: 'user@example.com',
        inviterId: 'inviter-1',
        organizationId: 'org-1',
        assignedRoleId: 'role-custom',
        assignedRole: { name: 'Billing Manager', rolePermissions: [] },
        status: 'pending',
        createdAt,
        expiresAt,
        organization: { name: 'Acme' },
      },
    ]);

    const result = await service.listPendingInvitationsForUser('user@example.com');

    expect(result).toEqual([
      {
        id: 'inv-1',
        email: 'user@example.com',
        inviterId: 'inviter-1',
        organizationId: 'org-1',
        role: 'Billing Manager',
        roleId: 'role-custom',
        status: 'pending',
        createdAt,
        expiresAt,
        organizationName: 'Acme',
      },
    ]);
  });

  it('redacts private-catalog role metadata on legacy invitations', async () => {
    mockPrisma.invitation.findMany.mockResolvedValue([
      {
        id: 'inv-hidden',
        email: 'user@example.com',
        inviterId: 'inviter-1',
        organizationId: 'org-1',
        assignedRoleId: 'role-local-admin',
        assignedRole: {
          name: 'Local Admin',
          rolePermissions: [{ permission: { resource: 'admin.users', action: 'read' } }],
        },
        status: 'pending',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        organization: { name: 'Acme' },
      },
    ]);

    await expect(service.listPendingInvitationsForUser('user@example.com')).resolves.toEqual([
      expect.objectContaining({ role: 'Managed role', roleId: null }),
    ]);
  });
});

describe('UsersService.listPendingInvitationsForUserPaginated', () => {
  let service: UsersService;

  const mockPrisma = {
    invitation: { findMany: vi.fn() },
  };

  const makeInvitations = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `inv${i}`,
      email: 'me@example.com',
      inviterId: 'inviter',
      organizationId: 'org',
      assignedRoleId: 'role-member',
      assignedRole: { name: 'Member', rolePermissions: [] },
      status: 'pending',
      createdAt: new Date(),
      expiresAt: new Date(),
      organization: { name: 'Acme' },
    }));

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaClient, useValue: mockPrisma },
        { provide: OrganizationInvitationsService, useValue: {} },
        { provide: 'AUTH_SESSION_CACHE', useValue: null },
        { provide: 'LoggerServiceUsersService', useValue: mockLogger },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('slices to the requested page and computes meta', async () => {
    mockPrisma.invitation.findMany.mockResolvedValue(makeInvitations(25));

    const result = await service.listPendingInvitationsForUserPaginated('me@example.com', { page: 2, pageSize: 10 });

    expect(result.data).toHaveLength(10);
    expect(result.data[0].id).toBe('inv10');
    expect(result.meta).toEqual({ page: 2, pageSize: 10, totalItems: 25, totalPages: 3 });
  });

  it('defaults to page 1 / pageSize 20 and reports zero pages when empty', async () => {
    mockPrisma.invitation.findMany.mockResolvedValue([]);

    const result = await service.listPendingInvitationsForUserPaginated('me@example.com', {});

    expect(result.data).toEqual([]);
    expect(result.meta).toEqual({ page: 1, pageSize: 20, totalItems: 0, totalPages: 0 });
  });
});

describe('UsersService.getAuthenticatedUser', () => {
  let service: UsersService;

  const mockPrisma = {
    user: {
      findUnique: vi.fn(),
    },
  };

  const row = {
    id: 'u1',
    email: 'me@example.com',
    emailVerified: true,
    name: 'Me',
    image: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-02-01T00:00:00Z'),
    role: 'user',
    banned: false,
    banReason: null,
    banExpires: null,
    phoneNumber: '+15550001111',
    auth0Id: 'auth0|abc',
    stripeCustomerId: 'cus_123',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaClient, useValue: mockPrisma },
        { provide: OrganizationInvitationsService, useValue: {} },
        { provide: 'AUTH_SESSION_CACHE', useValue: null },
        { provide: 'LoggerServiceUsersService', useValue: mockLogger },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns exactly the UserSchema fields — internal account fields are stripped', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(row);

    const result = await service.getAuthenticatedUser('u1');

    expect(result).toEqual({
      id: 'u1',
      email: 'me@example.com',
      emailVerified: true,
      name: 'Me',
      image: null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      role: 'user',
      banned: false,
      banReason: null,
      banExpires: null,
    });
    expect(result).not.toHaveProperty('phoneNumber');
    expect(result).not.toHaveProperty('auth0Id');
    expect(result).not.toHaveProperty('stripeCustomerId');
  });

  it('falls back to createdAt when updatedAt is null (pre-@updatedAt rows)', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ ...row, updatedAt: null });

    const result = await service.getAuthenticatedUser('u1');

    expect(result.updatedAt).toEqual(row.createdAt);
  });

  it('throws NotFoundException for a missing user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    await expect(service.getAuthenticatedUser('missing')).rejects.toBeInstanceOf(NotFoundException);
  });
});
