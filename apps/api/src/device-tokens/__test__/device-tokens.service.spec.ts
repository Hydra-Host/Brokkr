import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { ActiveRecordRegistry } from '@repo/active-record';
import {
  DeviceTokenAuditEventType,
  DeviceTokenContext,
  DeviceTokenRevocationReason,
  DeviceTokenStatus,
} from '@repo/database';
import { ContextService } from 'src/common/context/context.service';
import { ConfigAtomWriter, REDIS_CLIENT } from 'src/common/redis';
import { REDIS_KEYS } from 'src/common/redis/redis-keys';
import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { hashDeviceToken } from '../device-token.crypto';
import { DeviceTokensService } from '../device-tokens.service';

const PEPPER = 'test-pepper';
const PLAINTEXT = 'test-os-token-example';
const TOKEN_HASH = hashDeviceToken(PLAINTEXT, PEPPER);

const activeToken = {
  id: 'token-id',
  deviceId: 'device-id',
  deploymentId: 'deployment-id',
  context: DeviceTokenContext.DEPLOYMENT_OS,
  status: DeviceTokenStatus.ACTIVE,
  expiresAt: new Date(Date.now() + 60_000),
  device: {
    id: 'device-id',
    supplierId: 'supplier-id',
    zoneId: 'zone-id',
    systemUuid: 'system-uuid',
  },
};

function tokenRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'existing-token',
    deviceId: 'device-id',
    deploymentId: null,
    context: DeviceTokenContext.DEPLOYMENT_OS,
    tokenHash: 'existing-hash',
    displayId: 'existing-display',
    status: DeviceTokenStatus.ACTIVE,
    rotationGeneration: 0,
    expiresAt: null,
    lastUsedAt: null,
    lastUsedIp: null,
    revokedAt: null,
    revokedReason: null,
    revokedNote: null,
    issuedBy: 'system',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('DeviceTokensService', () => {
  let service: DeviceTokensService;
  let findUnique: Mock;
  let deviceFindUnique: Mock;
  let auditCreate: Mock;
  let redisSet: Mock;
  let writeAtomJson: Mock;
  let delKey: Mock;
  let transaction: Mock;
  let txTokenFindMany: Mock;
  let txTokenFindFirst: Mock;
  let txTokenCreate: Mock;
  let txTokenUpdate: Mock;
  let txAuditCreate: Mock;
  let configGet: Mock;

  beforeEach(async () => {
    findUnique = vi.fn();
    deviceFindUnique = vi.fn();
    auditCreate = vi.fn().mockResolvedValue({});
    redisSet = vi.fn().mockResolvedValue(null);
    writeAtomJson = vi.fn().mockResolvedValue(undefined);
    delKey = vi.fn().mockResolvedValue(undefined);

    const rowsById = new Map<string, Record<string, unknown>>();
    const remember = (rows: Record<string, unknown>[]): Record<string, unknown>[] => {
      for (const row of rows) rowsById.set(row.id as string, row);
      return rows;
    };

    txTokenFindMany = vi.fn(async () => []);
    txTokenFindFirst = vi.fn(async () => null);
    txTokenCreate = vi.fn((args: { data: Record<string, unknown> }) => ({
      ...tokenRow(),
      ...args.data,
      id: 'new-token',
      createdAt: new Date('2026-02-01T00:00:00Z'),
      updatedAt: new Date('2026-02-01T00:00:00Z'),
    }));
    txTokenUpdate = vi.fn((args: { where: { id: string }; data: Record<string, unknown> }) => ({
      ...(rowsById.get(args.where.id) ?? tokenRow({ id: args.where.id })),
      ...args.data,
      updatedAt: new Date('2026-03-01T00:00:00Z'),
    }));
    txAuditCreate = vi.fn().mockResolvedValue({});

    const tx = {
      deviceToken: {
        findMany: async (args?: object) => remember(((await txTokenFindMany(args)) ?? []) as Record<string, unknown>[]),
        findFirst: async (args?: object) => {
          const row = (await txTokenFindFirst(args)) as Record<string, unknown> | null;
          return row ? remember([row])[0] : null;
        },
        create: txTokenCreate,
        update: txTokenUpdate,
      },
      deviceTokenAuditEvent: { create: txAuditCreate },
    };
    transaction = vi.fn(<T>(cb: (txClient: typeof tx) => Promise<T>) => cb(tx));

    ActiveRecordRegistry.configureForTest({ deviceToken: tx.deviceToken }, null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceTokensService,
        {
          provide: PrismaClient,
          useValue: {
            device: { findUnique: deviceFindUnique },
            deviceToken: { findUnique },
            deviceTokenAuditEvent: { create: auditCreate },
            $transaction: transaction,
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: (configGet = vi.fn((key: string) => (key === 'DEVICE_TOKEN_PEPPER' ? PEPPER : undefined))),
            getOrThrow: vi.fn((key: string) => {
              if (key === 'DEVICE_TOKEN_PEPPER') return PEPPER;
              throw new Error(`unexpected config key: ${key}`);
            }),
          },
        },
        {
          provide: ContextService,
          useValue: { deviceIdentity: undefined, identity: undefined, userId: null },
        },
        { provide: REDIS_CLIENT, useValue: { set: redisSet, del: vi.fn() } },
        { provide: ConfigAtomWriter, useValue: { delKey, writeAtomJson } },
        {
          provide: 'LoggerServiceDeviceTokensService',
          useValue: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        },
      ],
    }).compile();

    service = module.get(DeviceTokensService);
  });

  it('fails closed when DEVICE_TOKEN_PEPPER is unset (no fallback)', () => {
    const config = {
      getOrThrow: vi.fn((key: string) => {
        throw new Error(`missing config: ${key}`);
      }),
    } as unknown as ConfigService;
    expect(
      () => new DeviceTokensService({} as never, config, {} as never, {} as never, {} as never, {} as never),
    ).toThrow('missing config: DEVICE_TOKEN_PEPPER');
  });

  it('fails closed when DEVICE_TOKEN_PEPPER is blank', () => {
    const config = { getOrThrow: vi.fn(() => '   ') } as unknown as ConfigService;
    expect(
      () => new DeviceTokensService({} as never, config, {} as never, {} as never, {} as never, {} as never),
    ).toThrow('DEVICE_TOKEN_PEPPER must be a non-empty secret');
  });

  it('rejects unknown token hashes', async () => {
    findUnique.mockResolvedValue(null);

    await expect(
      service.verifyPlaintextToken({ plaintext: PLAINTEXT, allowedContexts: [DeviceTokenContext.DEPLOYMENT_OS] }),
    ).rejects.toThrow(UnauthorizedException);
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { tokenHash: TOKEN_HASH } }));
  });

  it('rejects context mismatches after database lookup', async () => {
    findUnique.mockResolvedValue(activeToken);
    await expect(
      service.verifyPlaintextToken({ plaintext: PLAINTEXT, allowedContexts: [DeviceTokenContext.BROKKR_LIVE] }),
    ).rejects.toThrow(UnauthorizedException);
    expect(findUnique).toHaveBeenCalled();
  });

  it('audits used-after-revoke attempts', async () => {
    findUnique.mockResolvedValue({ ...activeToken, status: DeviceTokenStatus.REVOKED });

    await expect(
      service.verifyPlaintextToken({
        plaintext: PLAINTEXT,
        allowedContexts: [DeviceTokenContext.DEPLOYMENT_OS],
        ip: '127.0.0.1',
        userAgent: 'vitest',
      }),
    ).rejects.toThrow(UnauthorizedException);

    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tokenId: 'token-id',
        event: DeviceTokenAuditEventType.USED_AFTER_REVOKE,
        ip: '127.0.0.1',
        userAgent: 'vitest',
      }),
    });
  });

  it('audits used-after-expiry attempts', async () => {
    findUnique.mockResolvedValue({ ...activeToken, expiresAt: new Date(Date.now() - 60_000) });

    await expect(
      service.verifyPlaintextToken({ plaintext: PLAINTEXT, allowedContexts: [DeviceTokenContext.DEPLOYMENT_OS] }),
    ).rejects.toThrow(UnauthorizedException);

    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tokenId: 'token-id',
        event: DeviceTokenAuditEventType.USED_AFTER_EXPIRY,
      }),
    });
  });

  it('returns device identity and throttles last-used updates', async () => {
    findUnique.mockResolvedValue(activeToken);

    await expect(
      service.verifyPlaintextToken({
        plaintext: PLAINTEXT,
        allowedContexts: [DeviceTokenContext.DEPLOYMENT_OS],
        ip: '127.0.0.1',
      }),
    ).resolves.toMatchObject({
      deviceId: 'device-id',
      tokenId: 'token-id',
      context: DeviceTokenContext.DEPLOYMENT_OS,
      deploymentId: 'deployment-id',
      supplierId: 'supplier-id',
      zoneId: 'zone-id',
      systemUuid: 'system-uuid',
    });
    expect(redisSet).toHaveBeenCalledWith(REDIS_KEYS.deviceTokenLastUsed('token-id'), '1', 'EX', 60, 'NX');
  });

  it('publishes Brokkr Live material to the device server_token atom', async () => {
    deviceFindUnique.mockResolvedValue({ zoneId: 'zone-id' });
    const material = {
      brokkr_live_token: 'test-live-token-example',
      endpoint: 'https://hub.example/api/v1/bmc/phone-home',
      exp: 1_900_000_000,
    };

    await service.publishBrokkrLiveTokenMaterial({ deviceId: 'device-id', material, requestId: 'rotate:token-id' });

    expect(writeAtomJson).toHaveBeenCalledWith(
      'zone-id',
      'device:device-id:server_token',
      material,
      expect.any(Object),
      86_400,
      { request_id: 'rotate:token-id' },
    );
  });

  describe('phone-home endpoint base URL', () => {
    it('prefers PHONE_HOME_BASE_URL over BASE_URL (device must reach the gateway, not the auth plane)', async () => {
      configGet.mockImplementation((key: string) => {
        if (key === 'DEVICE_TOKEN_PEPPER') return PEPPER;
        if (key === 'PHONE_HOME_BASE_URL') return 'http://192.168.200.1:8001';
        if (key === 'BASE_URL') return 'http://localhost:3000';
        return undefined;
      });
      txTokenFindMany.mockResolvedValue([]);

      const issued = await service.issueDeploymentOsToken({ deviceId: 'device-id' });

      expect(issued.material.endpoint).toBe('http://192.168.200.1:8001/api/v1/bmc/phone-home');
    });

    it('falls back to BASE_URL when PHONE_HOME_BASE_URL is unset', async () => {
      configGet.mockImplementation((key: string) => {
        if (key === 'DEVICE_TOKEN_PEPPER') return PEPPER;
        if (key === 'BASE_URL') return 'https://hub.example';
        return undefined;
      });
      txTokenFindMany.mockResolvedValue([]);

      const issued = await service.issueDeploymentOsToken({ deviceId: 'device-id' });

      expect(issued.material.endpoint).toBe('https://hub.example/api/v1/bmc/phone-home');
    });
  });

  describe('issueToken (DEPLOYMENT_OS)', () => {
    it('revokes any existing active token before issuing, writes an ISSUED audit row, and returns deployment-os material', async () => {
      const existing = tokenRow({ id: 'old-deployment-token', context: DeviceTokenContext.DEPLOYMENT_OS });
      txTokenFindMany.mockResolvedValue([existing]);

      const issued = await service.issueDeploymentOsToken({ deviceId: 'device-id', issuedBy: 'admin' });

      const updateOrder = txTokenUpdate.mock.invocationCallOrder[0];
      const createOrder = txTokenCreate.mock.invocationCallOrder[0];
      expect(updateOrder).toBeLessThan(createOrder);
      expect(txTokenUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'old-deployment-token' }),
          data: expect.objectContaining({ status: DeviceTokenStatus.REVOKED }),
        }),
      );

      expect(txAuditCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tokenId: 'new-token',
          event: DeviceTokenAuditEventType.ISSUED,
          actor: 'admin',
        }),
      });

      expect(issued.material).toEqual({
        deployment_os_token: issued.plaintext,
        endpoint: expect.stringContaining('/bmc/phone-home'),
      });
      expect(issued.reused).toBe(false);
    });

    it('does not clear any Redis atom when only DEPLOYMENT_OS tokens are revoked', async () => {
      txTokenFindMany.mockResolvedValue([tokenRow({ id: 'old-deployment-token' })]);
      await service.issueDeploymentOsToken({ deviceId: 'device-id' });
      expect(delKey).not.toHaveBeenCalled();
    });
  });

  describe('issueToken (BROKKR_LIVE)', () => {
    it('writes an ISSUED audit row and returns brokkr-live material with an exp', async () => {
      txTokenFindMany.mockResolvedValue([]);

      const issued = await service.issueBrokkrLiveToken({ deviceId: 'device-id', issuedBy: 'system' });

      expect(txAuditCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ tokenId: 'new-token', event: DeviceTokenAuditEventType.ISSUED }),
      });
      expect(issued.material).toEqual({
        brokkr_live_token: issued.plaintext,
        endpoint: expect.stringContaining('/bmc/phone-home'),
        exp: expect.any(Number),
      });
    });

    it('clears the published Redis atom when an existing BROKKR_LIVE token is revoked on rotation', async () => {
      txTokenFindMany.mockResolvedValue([tokenRow({ id: 'old-live-token', context: DeviceTokenContext.BROKKR_LIVE })]);
      deviceFindUnique.mockResolvedValue({ zoneId: 'zone-id' });

      await service.issueBrokkrLiveToken({ deviceId: 'device-id' });

      expect(txTokenUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: DeviceTokenStatus.REVOKED }) }),
      );
      expect(delKey).toHaveBeenCalledWith('zone-id', 'device:device-id:server_token');
    });
  });

  describe('revokeRecord (via revokeToken)', () => {
    it('writes a ROTATED audit row when the revocation reason is ROTATION', async () => {
      txTokenFindFirst.mockResolvedValue(tokenRow({ id: 'tok-rotate', context: DeviceTokenContext.BROKKR_LIVE }));
      deviceFindUnique.mockResolvedValue({ zoneId: 'zone-id' });

      await service.revokeToken({ tokenId: 'tok-rotate', reason: DeviceTokenRevocationReason.ROTATION });

      expect(txAuditCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ tokenId: 'tok-rotate', event: DeviceTokenAuditEventType.ROTATED }),
      });
    });

    it('writes a REVOKED audit row for non-rotation reasons', async () => {
      txTokenFindFirst.mockResolvedValue(tokenRow({ id: 'tok-manual' }));

      await service.revokeToken({ tokenId: 'tok-manual', reason: DeviceTokenRevocationReason.MANUAL });

      expect(txAuditCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({ tokenId: 'tok-manual', event: DeviceTokenAuditEventType.REVOKED }),
      });
    });

    it('is a no-op (no audit row, no atom clear) when the token is already revoked', async () => {
      txTokenFindFirst.mockResolvedValue(
        tokenRow({ id: 'tok-already', context: DeviceTokenContext.BROKKR_LIVE, status: DeviceTokenStatus.REVOKED }),
      );

      await service.revokeToken({ tokenId: 'tok-already', reason: DeviceTokenRevocationReason.MANUAL });

      expect(txAuditCreate).not.toHaveBeenCalled();
      expect(delKey).not.toHaveBeenCalled();
    });
  });

  describe('runWithDeploymentTokenRevocation', () => {
    it('runs the action before revoking deployment tokens and returns the action result', async () => {
      const order: string[] = [];
      const action = vi.fn(async () => {
        order.push('action');
        return 'action-result';
      });
      txTokenUpdate.mockImplementation((args: { where: { id: string }; data: Record<string, unknown> }) => {
        order.push('revoke');
        return { ...tokenRow({ id: args.where.id }), ...args.data, updatedAt: new Date() };
      });
      txTokenFindMany.mockResolvedValue([tokenRow({ id: 'dep-token' })]);

      const result = await service.runWithDeploymentTokenRevocation(
        { deviceId: 'device-id', reason: DeviceTokenRevocationReason.DEPLOYMENT_ENDED },
        action,
      );

      expect(result).toBe('action-result');
      expect(order).toEqual(['action', 'revoke']);
    });
  });

  describe('clearPublishedAuthMaterialForRevokedTokens (BROKKR_LIVE-only filter)', () => {
    it('clears the Redis atom only for BROKKR_LIVE devices and filters DEPLOYMENT_OS out', async () => {
      txTokenFindMany.mockResolvedValue([
        tokenRow({ id: 'live-1', deviceId: 'device-live', context: DeviceTokenContext.BROKKR_LIVE }),
      ]);
      deviceFindUnique.mockResolvedValue({ zoneId: 'zone-live' });

      await service.revokeBrokkrLiveTokensForDevice('device-live', DeviceTokenRevocationReason.SUSPECTED_LEAK);
      expect(delKey).toHaveBeenCalledTimes(1);
      expect(delKey).toHaveBeenCalledWith('zone-live', 'device:device-live:server_token');

      delKey.mockClear();

      txTokenFindMany.mockResolvedValue([
        tokenRow({ id: 'dep-1', deviceId: 'device-dep', context: DeviceTokenContext.DEPLOYMENT_OS }),
      ]);
      await service.revokeDeploymentTokensForDevice('device-dep', DeviceTokenRevocationReason.SUSPECTED_LEAK);
      expect(delKey).not.toHaveBeenCalled();
    });
  });
});
