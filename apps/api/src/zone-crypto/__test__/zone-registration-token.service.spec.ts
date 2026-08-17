import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@repo/database';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { AuthType } from '../../auth/identity-context';
import { ContextService } from '../../common/context/context.service';
import { PrismaClient } from '../../prisma/prisma.client';
import { ZoneCryptoRepository } from '../zone-crypto.repository';
import { ZoneRegistrationTokenService } from '../zone-registration-token.service';

const ZONE_ID = '00000000-0000-4000-8000-000000000001';
const ADMIN_USER_ID = 'admin-user-uuid';
const TOKEN_TTL_HOURS = 24;
const TOKEN_TTL_MS = TOKEN_TTL_HOURS * 60 * 60 * 1000;

describe('ZoneRegistrationTokenService', () => {
  let service: ZoneRegistrationTokenService;
  let mockPrisma: {
    zone: { findUnique: Mock };
    zoneRegistrationToken: { create: Mock; findFirst: Mock; findUnique: Mock; update: Mock; updateMany: Mock };
    $transaction: Mock;
    $executeRaw: Mock;
  };
  let mockRepository: { findRegistrationTokensByZoneId: Mock };
  let mockContext: {
    userId: string;
    identity: { authType: AuthType };
    requirePermission: Mock;
    buildAuditPayload: Mock;
  };

  beforeEach(async () => {
    mockPrisma = {
      zone: { findUnique: vi.fn() },
      zoneRegistrationToken: {
        create: vi.fn(),
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: vi.fn(async (cb: (tx: typeof mockPrisma) => Promise<unknown>) => cb(mockPrisma)),
      $executeRaw: vi.fn().mockResolvedValue(undefined),
    };
    mockRepository = { findRegistrationTokensByZoneId: vi.fn().mockResolvedValue([]) };
    mockContext = {
      userId: ADMIN_USER_ID,
      identity: { authType: AuthType.Session },
      requirePermission: vi.fn(),
      buildAuditPayload: vi.fn().mockReturnValue({
        triggeredBy: ADMIN_USER_ID,
        triggeredByEmail: 'admin@hydrahost.test',
        organizationId: 'hydrahost-org-uuid',
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ZoneRegistrationTokenService,
        { provide: PrismaClient, useValue: mockPrisma },
        { provide: ZoneCryptoRepository, useValue: mockRepository },
        { provide: ContextService, useValue: mockContext },
        {
          provide: `LoggerService${ZoneRegistrationTokenService.name}`,
          useValue: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        },
      ],
    }).compile();

    service = module.get(ZoneRegistrationTokenService);
  });

  describe('auth type enforcement', () => {
    it('rejects API-key auth before role check or DB work (defense-in-depth)', async () => {
      mockContext.identity = { authType: AuthType.ApiKey };

      await expect(service.mintRegistrationToken(ZONE_ID)).rejects.toThrow(ForbiddenException);
      expect(mockContext.requirePermission).not.toHaveBeenCalled();
      expect(mockPrisma.zone.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.zoneRegistrationToken.create).not.toHaveBeenCalled();
    });
  });

  describe('role enforcement', () => {
    it('calls contextService.requirePermission with zone:register before any DB work', async () => {
      mockPrisma.zone.findUnique.mockResolvedValue({ id: ZONE_ID });
      mockPrisma.zoneRegistrationToken.create.mockResolvedValue({
        id: 'token-row',
        zoneId: ZONE_ID,
        expiresAt: new Date(),
        createdAt: new Date(),
        createdById: ADMIN_USER_ID,
      });

      await service.mintRegistrationToken(ZONE_ID);

      expect(mockContext.requirePermission).toHaveBeenCalledWith('zone', 'register');
      const requirePermissionOrder = mockContext.requirePermission.mock.invocationCallOrder[0];
      const zoneLookupOrder = mockPrisma.zone.findUnique.mock.invocationCallOrder[0];
      expect(requirePermissionOrder).toBeLessThan(zoneLookupOrder);
    });

    it('propagates the ForbiddenException from requirePermission without touching the DB', async () => {
      const forbidden = new Error('insufficient role');
      mockContext.requirePermission.mockImplementation(() => {
        throw forbidden;
      });

      await expect(service.mintRegistrationToken(ZONE_ID)).rejects.toThrow(forbidden);
      expect(mockPrisma.zone.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.zoneRegistrationToken.create).not.toHaveBeenCalled();
    });
  });

  describe('audit logging — buildAuditPayload invocation', () => {
    it('mintRegistrationToken calls buildAuditPayload', async () => {
      mockPrisma.zone.findUnique.mockResolvedValue({ id: ZONE_ID });
      mockPrisma.zoneRegistrationToken.create.mockResolvedValue({
        id: 'token-row',
        zoneId: ZONE_ID,
        expiresAt: new Date(),
        createdAt: new Date(),
        createdById: ADMIN_USER_ID,
      });

      await service.mintRegistrationToken(ZONE_ID);

      expect(mockContext.buildAuditPayload).toHaveBeenCalledTimes(1);
    });

    it('invalidateRegistrationToken calls buildAuditPayload on success path', async () => {
      mockPrisma.zoneRegistrationToken.findUnique.mockResolvedValue({
        id: 'token-id',
        zoneId: ZONE_ID,
        consumedAt: null,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });

      await service.invalidateRegistrationToken(ZONE_ID, 'token-id');

      expect(mockContext.buildAuditPayload).toHaveBeenCalledTimes(1);
    });

    it('invalidateRegistrationToken calls buildAuditPayload on the idempotent no-op path', async () => {
      mockPrisma.zoneRegistrationToken.findUnique.mockResolvedValue({
        id: 'token-id',
        zoneId: ZONE_ID,
        consumedAt: null,
        expiresAt: new Date(Date.now() - 60 * 60 * 1000),
      });

      await service.invalidateRegistrationToken(ZONE_ID, 'token-id');

      expect(mockContext.buildAuditPayload).toHaveBeenCalledTimes(1);
    });
  });

  describe('zone existence check', () => {
    it('throws NotFoundException when the zone does not exist', async () => {
      mockPrisma.zone.findUnique.mockResolvedValue(null);

      await expect(service.mintRegistrationToken(ZONE_ID)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.zoneRegistrationToken.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a soft-deleted (deprovisioned) zone', async () => {
      mockPrisma.zone.findUnique.mockResolvedValue({ id: ZONE_ID, deletedAt: new Date() });

      await expect(service.mintRegistrationToken(ZONE_ID)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.zoneRegistrationToken.create).not.toHaveBeenCalled();
    });

    it('looks up the zone by id (findUnique, not findFirst)', async () => {
      mockPrisma.zone.findUnique.mockResolvedValue({ id: ZONE_ID });
      mockPrisma.zoneRegistrationToken.create.mockResolvedValue({
        id: 'token-row',
        zoneId: ZONE_ID,
        expiresAt: new Date(),
        createdAt: new Date(),
        createdById: ADMIN_USER_ID,
      });

      await service.mintRegistrationToken(ZONE_ID);
      expect(mockPrisma.zone.findUnique).toHaveBeenCalledWith({ where: { id: ZONE_ID } });
    });
  });

  describe('successful mint', () => {
    beforeEach(() => {
      mockPrisma.zone.findUnique.mockResolvedValue({ id: ZONE_ID });
      mockPrisma.zoneRegistrationToken.create.mockImplementation(({ data }) =>
        Promise.resolve({
          id: 'token-row-uuid',
          ...data,
          createdAt: new Date(),
        }),
      );
    });

    it('returns a base64url-encoded raw token (43 chars, URL-safe)', async () => {
      const result = await service.mintRegistrationToken(ZONE_ID);

      expect(result.token).toHaveLength(43);
      expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('persists only the SHA-256 hash, not the raw token', async () => {
      const result = await service.mintRegistrationToken(ZONE_ID);

      const createCall = mockPrisma.zoneRegistrationToken.create.mock.calls[0]?.[0];
      expect(createCall).toBeDefined();

      const expectedHash = createHash('sha256').update(result.token, 'utf8').digest('hex');
      expect(createCall.data.tokenHash).toBe(expectedHash);
      expect(JSON.stringify(createCall.data)).not.toContain(result.token);
    });

    it('sets expiresAt to ~24 hours from creation', async () => {
      const before = Date.now();
      await service.mintRegistrationToken(ZONE_ID);
      const after = Date.now();

      const createCall = mockPrisma.zoneRegistrationToken.create.mock.calls[0]?.[0];
      const expiresAtMs = (createCall.data.expiresAt as Date).getTime();
      expect(expiresAtMs).toBeGreaterThanOrEqual(before + TOKEN_TTL_MS);
      expect(expiresAtMs).toBeLessThanOrEqual(after + TOKEN_TTL_MS);
    });

    it('records the admin user from ContextService as createdById', async () => {
      await service.mintRegistrationToken(ZONE_ID);

      const createCall = mockPrisma.zoneRegistrationToken.create.mock.calls[0]?.[0];
      expect(createCall.data.createdById).toBe(ADMIN_USER_ID);
    });

    it('binds the token to the requested zoneId', async () => {
      await service.mintRegistrationToken(ZONE_ID);

      const createCall = mockPrisma.zoneRegistrationToken.create.mock.calls[0]?.[0];
      expect(createCall.data.zoneId).toBe(ZONE_ID);
    });

    it('returns response shape matching the contract', async () => {
      const result = await service.mintRegistrationToken(ZONE_ID);

      expect(result).toMatchObject({
        token: expect.any(String),
        tokenId: expect.any(String),
        zoneId: ZONE_ID,
        expiresAt: expect.any(Date),
        createdAt: expect.any(Date),
        createdById: ADMIN_USER_ID,
      });
    });
  });

  describe('entropy', () => {
    beforeEach(() => {
      mockPrisma.zone.findUnique.mockResolvedValue({ id: ZONE_ID });
      mockPrisma.zoneRegistrationToken.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'row', ...data, createdAt: new Date() }),
      );
    });

    it('produces a different token on each mint (crypto.randomBytes, not predictable)', async () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 50; i++) {
        const result = await service.mintRegistrationToken(ZONE_ID);
        tokens.add(result.token);
      }
      expect(tokens.size).toBe(50);
    });

    it('decoded token is exactly 32 bytes', async () => {
      const result = await service.mintRegistrationToken(ZONE_ID);
      const decoded = Buffer.from(result.token, 'base64url');
      expect(decoded.length).toBe(32);
    });
  });

  describe('mint guardrail — existing unused token', () => {
    beforeEach(() => {
      mockPrisma.zone.findUnique.mockResolvedValue({ id: ZONE_ID });
      mockPrisma.zoneRegistrationToken.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'token-row-uuid', ...data, createdAt: new Date() }),
      );
    });

    it('refuses with 409 when an unused, unexpired token already exists for the zone', async () => {
      mockPrisma.zoneRegistrationToken.findFirst.mockResolvedValue({ id: 'existing-token-uuid' });

      await expect(service.mintRegistrationToken(ZONE_ID)).rejects.toThrow(ConflictException);
      expect(mockPrisma.zoneRegistrationToken.create).not.toHaveBeenCalled();
    });

    it('the 409 response carries the existingTokenId so admins can invalidate it', async () => {
      mockPrisma.zoneRegistrationToken.findFirst.mockResolvedValue({ id: 'existing-token-uuid' });

      try {
        await service.mintRegistrationToken(ZONE_ID);
        throw new Error('expected mintRegistrationToken to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ConflictException);
        const response = (error as ConflictException).getResponse();
        expect(response).toMatchObject({
          message: expect.stringContaining('already exists'),
          existingTokenId: 'existing-token-uuid',
        });
      }
    });

    it('queries findFirst with the correct filters (consumedAt null AND expiresAt > now)', async () => {
      mockPrisma.zoneRegistrationToken.findFirst.mockResolvedValue(null);

      await service.mintRegistrationToken(ZONE_ID);

      const arg = mockPrisma.zoneRegistrationToken.findFirst.mock.calls[0]?.[0];
      expect(arg.where).toMatchObject({ zoneId: ZONE_ID, consumedAt: null });
      expect(arg.where.expiresAt).toEqual({ gt: expect.any(Date) });
    });

    it('mints normally when there is no prior unused token (findFirst returns null)', async () => {
      mockPrisma.zoneRegistrationToken.findFirst.mockResolvedValue(null);

      await expect(service.mintRegistrationToken(ZONE_ID)).resolves.toMatchObject({ zoneId: ZONE_ID });
      expect(mockPrisma.zoneRegistrationToken.create).toHaveBeenCalled();
    });

    it('serializes concurrent mints under a Postgres advisory transaction lock keyed on zoneId', async () => {
      mockPrisma.zoneRegistrationToken.findFirst.mockResolvedValue(null);

      await service.mintRegistrationToken(ZONE_ID);

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
      const call = mockPrisma.$executeRaw.mock.calls[0];
      const sqlParts = call[0] as ReadonlyArray<string>;
      const boundValue = call[1];
      expect(sqlParts.join('?')).toContain('pg_advisory_xact_lock(hashtext(');
      expect(boundValue).toBe(`zone_mint:${ZONE_ID}`);
    });

    it('acquires the lock but skips create when the existing-token guardrail fires', async () => {
      mockPrisma.zoneRegistrationToken.findFirst.mockResolvedValue({ id: 'existing-token-uuid' });

      await expect(service.mintRegistrationToken(ZONE_ID)).rejects.toThrow(ConflictException);
      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(mockPrisma.zoneRegistrationToken.create).not.toHaveBeenCalled();
    });
  });

  describe('invalidateRegistrationToken', () => {
    const TOKEN_ID = 'token-to-invalidate';
    const FUTURE_DATE = new Date(Date.now() + 60 * 60 * 1000);
    const PAST_DATE = new Date(Date.now() - 60 * 60 * 1000);

    it('rejects API-key auth before role check or DB work', async () => {
      mockContext.identity = { authType: AuthType.ApiKey };

      await expect(service.invalidateRegistrationToken(ZONE_ID, TOKEN_ID)).rejects.toThrow(ForbiddenException);
      expect(mockContext.requirePermission).not.toHaveBeenCalled();
      expect(mockPrisma.zoneRegistrationToken.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.zoneRegistrationToken.update).not.toHaveBeenCalled();
    });

    it('calls requirePermission with zone:register', async () => {
      mockPrisma.zoneRegistrationToken.findUnique.mockResolvedValue({
        id: TOKEN_ID,
        zoneId: ZONE_ID,
        consumedAt: null,
        expiresAt: FUTURE_DATE,
      });

      await service.invalidateRegistrationToken(ZONE_ID, TOKEN_ID);

      expect(mockContext.requirePermission).toHaveBeenCalledWith('zone', 'register');
    });

    it('throws NotFoundException when token id does not exist', async () => {
      mockPrisma.zoneRegistrationToken.findUnique.mockResolvedValue(null);

      await expect(service.invalidateRegistrationToken(ZONE_ID, TOKEN_ID)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.zoneRegistrationToken.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when token belongs to a different zone (no disclosure)', async () => {
      mockPrisma.zoneRegistrationToken.findUnique.mockResolvedValue({
        id: TOKEN_ID,
        zoneId: 'different-zone-uuid',
        consumedAt: null,
        expiresAt: FUTURE_DATE,
      });

      await expect(service.invalidateRegistrationToken(ZONE_ID, TOKEN_ID)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.zoneRegistrationToken.update).not.toHaveBeenCalled();
    });

    it('throws ConflictException when token has already been consumed by a bridge', async () => {
      mockPrisma.zoneRegistrationToken.findUnique.mockResolvedValue({
        id: TOKEN_ID,
        zoneId: ZONE_ID,
        consumedAt: new Date(),
        expiresAt: FUTURE_DATE,
      });

      await expect(service.invalidateRegistrationToken(ZONE_ID, TOKEN_ID)).rejects.toThrow(ConflictException);
      expect(mockPrisma.zoneRegistrationToken.update).not.toHaveBeenCalled();
    });

    it('is idempotent on already-expired tokens (no write, no throw)', async () => {
      mockPrisma.zoneRegistrationToken.findUnique.mockResolvedValue({
        id: TOKEN_ID,
        zoneId: ZONE_ID,
        consumedAt: null,
        expiresAt: PAST_DATE,
      });

      await expect(service.invalidateRegistrationToken(ZONE_ID, TOKEN_ID)).resolves.toBeUndefined();
      expect(mockPrisma.zoneRegistrationToken.update).not.toHaveBeenCalled();
    });

    it('sets expiresAt to ~now on a live token (conditional where pins consumedAt: null)', async () => {
      mockPrisma.zoneRegistrationToken.findUnique.mockResolvedValue({
        id: TOKEN_ID,
        zoneId: ZONE_ID,
        consumedAt: null,
        expiresAt: FUTURE_DATE,
      });

      const before = Date.now();
      await service.invalidateRegistrationToken(ZONE_ID, TOKEN_ID);
      const after = Date.now();

      expect(mockPrisma.zoneRegistrationToken.update).toHaveBeenCalledWith({
        where: { id: TOKEN_ID, consumedAt: null },
        data: { expiresAt: expect.any(Date) },
      });
      const updateCall = mockPrisma.zoneRegistrationToken.update.mock.calls[0]?.[0];
      const newExpiresAtMs = (updateCall.data.expiresAt as Date).getTime();
      expect(newExpiresAtMs).toBeGreaterThanOrEqual(before);
      expect(newExpiresAtMs).toBeLessThanOrEqual(after);
    });

    it('throws ConflictException when a bridge consumes the token between read and update (P2025 race)', async () => {
      mockPrisma.zoneRegistrationToken.findUnique.mockResolvedValue({
        id: TOKEN_ID,
        zoneId: ZONE_ID,
        consumedAt: null,
        expiresAt: FUTURE_DATE,
      });
      const p2025 = new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
        code: 'P2025',
        clientVersion: 'test',
      });
      mockPrisma.zoneRegistrationToken.update.mockRejectedValue(p2025);

      await expect(service.invalidateRegistrationToken(ZONE_ID, TOKEN_ID)).rejects.toThrow(ConflictException);
    });

    it('lets non-P2025 prisma errors propagate (catch is narrow)', async () => {
      mockPrisma.zoneRegistrationToken.findUnique.mockResolvedValue({
        id: TOKEN_ID,
        zoneId: ZONE_ID,
        consumedAt: null,
        expiresAt: FUTURE_DATE,
      });
      const otherError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed.', {
        code: 'P2002',
        clientVersion: 'test',
      });
      mockPrisma.zoneRegistrationToken.update.mockRejectedValue(otherError);

      await expect(service.invalidateRegistrationToken(ZONE_ID, TOKEN_ID)).rejects.toBe(otherError);
    });
  });

  describe('listRegistrationTokens', () => {
    it('rejects API-key auth before role check or DB work', async () => {
      mockContext.identity = { authType: AuthType.ApiKey };

      await expect(service.listRegistrationTokens(ZONE_ID)).rejects.toThrow(ForbiddenException);
      expect(mockContext.requirePermission).not.toHaveBeenCalled();
      expect(mockPrisma.zone.findUnique).not.toHaveBeenCalled();
    });

    it('calls requirePermission with zone:register', async () => {
      mockPrisma.zone.findUnique.mockResolvedValue({ id: ZONE_ID });

      await service.listRegistrationTokens(ZONE_ID);

      expect(mockContext.requirePermission).toHaveBeenCalledWith('zone', 'register');
    });

    it('throws NotFoundException for a missing or soft-deleted zone', async () => {
      mockPrisma.zone.findUnique.mockResolvedValue(null);
      await expect(service.listRegistrationTokens(ZONE_ID)).rejects.toThrow(NotFoundException);

      mockPrisma.zone.findUnique.mockResolvedValue({ id: ZONE_ID, deletedAt: new Date() });
      await expect(service.listRegistrationTokens(ZONE_ID)).rejects.toThrow(NotFoundException);
    });

    it('derives consumed / expired / unused status and resolves mintedByEmail', async () => {
      mockPrisma.zone.findUnique.mockResolvedValue({ id: ZONE_ID });
      const past = new Date(Date.now() - 60 * 60 * 1000);
      const future = new Date(Date.now() + 60 * 60 * 1000);
      mockRepository.findRegistrationTokensByZoneId.mockResolvedValue([
        {
          id: 't-consumed',
          zoneId: ZONE_ID,
          createdById: ADMIN_USER_ID,
          createdBy: { id: ADMIN_USER_ID, email: 'minter@hydrahost.test' },
          createdAt: past,
          expiresAt: past,
          consumedAt: past,
        },
        {
          id: 't-expired',
          zoneId: ZONE_ID,
          createdById: ADMIN_USER_ID,
          createdBy: null,
          createdAt: past,
          expiresAt: past,
          consumedAt: null,
        },
        {
          id: 't-unused',
          zoneId: ZONE_ID,
          createdById: ADMIN_USER_ID,
          createdBy: { id: ADMIN_USER_ID, email: 'minter@hydrahost.test' },
          createdAt: past,
          expiresAt: future,
          consumedAt: null,
        },
      ]);

      const result = await service.listRegistrationTokens(ZONE_ID);

      expect(result.map((t) => t.status)).toEqual(['consumed', 'expired', 'unused']);
      expect(result[1].mintedByEmail).toBeNull();
      expect(result[0].mintedByEmail).toBe('minter@hydrahost.test');
    });
  });

  describe('mintRegistrationTokenForSim (sim-gated, non-interactive)', () => {
    const SIM_OWNER_ID = 'sim-owner-user-uuid';
    const envSnapshot = { ...process.env };

    afterEach(() => {
      process.env = { ...envSnapshot };
    });

    function enableSim(): void {
      process.env.LOCAL_SIMULATION_ENABLED = 'true';
      process.env.HH_ENV = 'dev';
      delete process.env.NODE_ENV;
      delete process.env.AUTH_BYPASS_ALLOWED_ENVS;
    }

    it('refuses when LOCAL_SIMULATION_ENABLED is unset (gate fail-closed, before any DB work)', async () => {
      delete process.env.LOCAL_SIMULATION_ENABLED;
      process.env.HH_ENV = 'dev';

      await expect(service.mintRegistrationTokenForSim(ZONE_ID, SIM_OWNER_ID)).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.zone.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.zoneRegistrationToken.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.zoneRegistrationToken.create).not.toHaveBeenCalled();
    });

    it('refuses in a non-permitted env even with the flag on (NODE_ENV=production kill-switch)', async () => {
      process.env.LOCAL_SIMULATION_ENABLED = 'true';
      process.env.HH_ENV = 'dev';
      process.env.NODE_ENV = 'production';

      await expect(service.mintRegistrationTokenForSim(ZONE_ID, SIM_OWNER_ID)).rejects.toThrow(ForbiddenException);
      expect(mockPrisma.zoneRegistrationToken.create).not.toHaveBeenCalled();
    });

    it('does NOT call assertInteractiveAdmin — mints with no session and no admin role', async () => {
      enableSim();
      mockContext.identity = undefined as unknown as { authType: AuthType };
      mockPrisma.zone.findUnique.mockResolvedValue({ id: ZONE_ID });
      mockPrisma.zoneRegistrationToken.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'sim-token-row', ...data, createdAt: new Date() }),
      );

      const result = await service.mintRegistrationTokenForSim(ZONE_ID, SIM_OWNER_ID);

      expect(result.zoneId).toBe(ZONE_ID);
      expect(mockContext.requirePermission).not.toHaveBeenCalled();
    });

    it('records the passed sim Owner as createdById (real FK + audit actor)', async () => {
      enableSim();
      mockPrisma.zone.findUnique.mockResolvedValue({ id: ZONE_ID });
      mockPrisma.zoneRegistrationToken.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'sim-token-row', ...data, createdAt: new Date() }),
      );

      const result = await service.mintRegistrationTokenForSim(ZONE_ID, SIM_OWNER_ID);

      expect(result.createdById).toBe(SIM_OWNER_ID);
      const createCall = mockPrisma.zoneRegistrationToken.create.mock.calls[0]?.[0];
      expect(createCall.data.createdById).toBe(SIM_OWNER_ID);
    });

    it('idempotent: expires a prior unused token before minting (no 409 on re-run)', async () => {
      enableSim();
      mockPrisma.zone.findUnique.mockResolvedValue({ id: ZONE_ID });
      mockPrisma.zoneRegistrationToken.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.zoneRegistrationToken.create.mockImplementation(({ data }) =>
        Promise.resolve({ id: 'sim-token-row', ...data, createdAt: new Date() }),
      );

      await expect(service.mintRegistrationTokenForSim(ZONE_ID, SIM_OWNER_ID)).resolves.toMatchObject({
        zoneId: ZONE_ID,
      });

      const expireCall = mockPrisma.zoneRegistrationToken.updateMany.mock.calls[0]?.[0];
      expect(expireCall.where).toMatchObject({ zoneId: ZONE_ID, consumedAt: null });
      expect(expireCall.where.expiresAt).toEqual({ gt: expect.any(Date) });
      expect(mockPrisma.zoneRegistrationToken.create).toHaveBeenCalled();
    });
  });
});
