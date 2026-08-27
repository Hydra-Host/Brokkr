import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { ContextService } from 'src/common/context/context.service';
import { EventLogService } from 'src/event-log/event-log.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SshKeysService } from '../sshkeys.service';

const ED25519_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKVkht1ZdckTEe2WZwwFgJX+cot8xSf5CAYaYqGtQKJ6';
const ED25519_FP = 'SHA256:TCzqHyUTYIf0YZCdq/F9k8JPYKElvkd39ZBWhP5mEAo';
const ED25519_BODY = ED25519_KEY.slice('ssh-ed25519 '.length);
const WRAPPED_ED25519_KEY = `ssh-ed25519 ${ED25519_BODY.slice(0, 12)}\n${ED25519_BODY.slice(12)}`;
const FORMATTED_ED25519_KEYS: [string, string][] = [
  ['LF', `# workstation\n${ED25519_KEY}\n`],
  ['CRLF', `# workstation\r\n${ED25519_KEY}\r\n`],
  ['CR', `# workstation\r${ED25519_KEY}\r`],
  ['comment lines', `# first\n# second\n${ED25519_KEY}`],
  ['wrapped key material', WRAPPED_ED25519_KEY],
];
const RSA_KEY =
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDqJ5yMyY7Z+5R1GsW4U5gM9kD7OyArUZT1CDE/rbyTUVUKxdAs5bb8b5SKYS1j8/18trVJvDPdvrkrL9NzHKRvjFNm/lgoB1ifZ1tUZ/S2zd1+Es4f9kSsJGNiV2i6EjB+gjNfCtkVs93k/wOijKbcCh7SQuPSbg+AlRIQJ+UUj9I8A1a5yOWvwuP4oK1f9hcdz3T4/Zgy2JgDkvdhms+dFBl27J02WUE7NXjBS6i0QrpWw2lEGvMylFo+f4CIMeUNKRec/d8D59Vv5Z/lUUIqKXOpECtoj93E6SD/mW7Rqp8LFfKZoi4YYGhpRmKHAY0pfAWnbDFsS7JKQ9w5/xh';
const RSA_FP = 'SHA256:4Ce2nvi/+xKBSwPGbnD2/VzeDMat/uar6F8/nKLPBv8';
const ECDSA_KEY =
  'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBL3EUCZt7l876ee9C5K0pPnlSvcc0ZC1BCd1vlRDIMHWTvrJJhMeoNCN4lQsyI9TceMIsIZvANrsgFv5GGArlCc=';
const ECDSA_FP = 'SHA256:n1otMcHCErs3nlWhl4AIxDE2oQDoCXSTOvRB8TneF/c';

const CURRENT_USER_ID = 'user-1';
const CURRENT_ORG_ID = 'org-1';

describe('SshKeysService', () => {
  let service: SshKeysService;

  const mockPrisma = {
    sshKeys: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    member: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma)),
  };

  const mockContext = {
    userId: CURRENT_USER_ID,
    organizationId: CURRENT_ORG_ID,
    requirePermission: vi.fn(),
    actorFields: vi.fn(() => ({
      actorType: 'UI',
      actorId: CURRENT_USER_ID,
      actorLabel: 'a@example.com',
      apiKeyId: null,
      apiKeyLabel: null,
    })),
    requestFields: vi.fn(() => ({ method: 'POST', path: '/api/v1/ssh-keys', ipAddress: null, userAgent: null })),
    requestId: 'req-1',
    finalizeIntents: vi.fn(),
  };

  const mockEventLog = { recordInTransaction: vi.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SshKeysService,
        { provide: PrismaClient, useValue: mockPrisma },
        { provide: ContextService, useValue: mockContext },
        { provide: EventLogService, useValue: mockEventLog },
      ],
    }).compile();

    service = module.get<SshKeysService>(SshKeysService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getFingerprint', () => {
    it('computes the fingerprint for a valid ed25519 key', async () => {
      await expect(service.getFingerprint(ED25519_KEY)).resolves.toBe(ED25519_FP);
    });

    it('computes the fingerprint for a valid rsa key', async () => {
      await expect(service.getFingerprint(RSA_KEY)).resolves.toBe(RSA_FP);
    });

    it('computes the fingerprint for a valid ecdsa key', async () => {
      await expect(service.getFingerprint(ECDSA_KEY)).resolves.toBe(ECDSA_FP);
    });

    it('recognizes a FIDO sk- prefix and fingerprints its key blob', async () => {
      const blob = ED25519_KEY.split(' ')[1];
      await expect(service.getFingerprint(`sk-ssh-ed25519@openssh.com ${blob}`)).resolves.toBe(ED25519_FP);
    });

    it('tolerates a comment field after the key body', async () => {
      await expect(service.getFingerprint(`${ED25519_KEY} user@host`)).resolves.toBe(ED25519_FP);
    });

    it.each(FORMATTED_ED25519_KEYS)('normalizes %s before fingerprinting', async (_, key) => {
      await expect(service.getFingerprint(key)).resolves.toBe(ED25519_FP);
    });

    it('rejects an incomplete key with fewer than 2 fields', async () => {
      await expect(service.getFingerprint('ssh-ed25519')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a key of unknown type', async () => {
      await expect(service.getFingerprint('ssh-unknown AAAAB3Nz')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects the trailing-type-token edge case with a clean BadRequestException', async () => {
      await expect(service.getFingerprint('foo ssh-ed25519')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('getSshKeyById (userId-scoped)', () => {
    it('queries scoped to the current userId and returns the key', async () => {
      const key = { id: 'k1', userId: CURRENT_USER_ID };
      mockPrisma.sshKeys.findUnique.mockResolvedValue(key);

      await expect(service.getSshKeyById('k1')).resolves.toBe(key);
      expect(mockPrisma.sshKeys.findUnique).toHaveBeenCalledWith({
        where: { id: 'k1', userId: CURRENT_USER_ID, dateDeleted: null },
      });
    });

    it('throws NotFoundException when no key matches the scoped lookup', async () => {
      mockPrisma.sshKeys.findUnique.mockResolvedValue(null);

      await expect(service.getSshKeyById('k1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('deleteSshKey (userId-scoped)', () => {
    it('soft-deletes only when the key belongs to the current user', async () => {
      mockPrisma.sshKeys.findUnique.mockResolvedValue({ id: 'k1', userId: CURRENT_USER_ID });
      mockPrisma.sshKeys.update.mockResolvedValue({ id: 'k1' });

      await service.deleteSshKey('k1');
      expect(mockContext.requirePermission).toHaveBeenCalledWith('ssh-key', 'delete');

      expect(mockPrisma.sshKeys.findUnique).toHaveBeenCalledWith({
        where: { id: 'k1', userId: CURRENT_USER_ID, dateDeleted: null },
      });
      expect(mockPrisma.sshKeys.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'k1', userId: CURRENT_USER_ID },
          data: expect.objectContaining({ dateDeleted: expect.any(Date) }),
        }),
      );
    });

    it('throws NotFoundException and does not delete a key owned by another user', async () => {
      mockPrisma.sshKeys.findUnique.mockResolvedValue(null);

      await expect(service.deleteSshKey('k1')).rejects.toBeInstanceOf(NotFoundException);
      expect(mockPrisma.sshKeys.update).not.toHaveBeenCalled();
    });
  });

  describe('getSshKeysByOrganizationId (org-member-scoped)', () => {
    it('only returns keys belonging to current-org members', async () => {
      mockPrisma.member.findMany.mockResolvedValue([{ userId: 'member-a' }, { userId: 'member-b' }]);
      const orgKeys = [{ id: 'k1', userId: 'member-a' }];
      mockPrisma.sshKeys.findMany.mockResolvedValue(orgKeys);

      await expect(service.getSshKeysByOrganizationId({})).resolves.toEqual(expect.objectContaining({ data: orgKeys }));

      expect(mockPrisma.member.findMany).toHaveBeenCalledWith({
        where: { organizationId: CURRENT_ORG_ID, deletedAt: null },
        select: { userId: true },
      });
      expect(mockPrisma.sshKeys.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId: { in: ['member-a', 'member-b'] },
            dateDeleted: null,
          }),
        }),
      );
    });
  });

  describe('createSshKey', () => {
    it.each(FORMATTED_ED25519_KEYS)('stores the canonical key for %s input', async (_, key) => {
      mockPrisma.sshKeys.findFirst.mockResolvedValue(null);
      mockPrisma.sshKeys.create.mockResolvedValue({ id: 'created' });

      await service.createSshKey({ name: 'workstation', key });

      expect(mockPrisma.sshKeys.findFirst).toHaveBeenCalledWith({
        where: {
          fingerprint: ED25519_FP,
          userId: CURRENT_USER_ID,
          dateDeleted: null,
        },
      });
      expect(mockPrisma.sshKeys.create).toHaveBeenCalledWith({
        data: {
          user: { connect: { id: CURRENT_USER_ID } },
          name: 'workstation',
          key: ED25519_KEY,
          fingerprint: ED25519_FP,
          dateDeleted: null,
        },
      });
    });

    it('rejects a formatted key when an active legacy row has the same fingerprint', async () => {
      mockPrisma.sshKeys.findFirst.mockResolvedValue({
        id: 'legacy',
        key: `${ED25519_KEY} old-comment`,
        fingerprint: ED25519_FP,
      });

      await expect(service.createSshKey({ name: 'workstation', key: WRAPPED_ED25519_KEY })).rejects.toThrow(
        'SSH key already exists',
      );

      expect(mockPrisma.sshKeys.findFirst).toHaveBeenCalledWith({
        where: {
          fingerprint: ED25519_FP,
          userId: CURRENT_USER_ID,
          dateDeleted: null,
        },
      });
      expect(mockPrisma.sshKeys.create).not.toHaveBeenCalled();
    });

    it('requires ssh-key:create before touching the store', async () => {
      mockContext.requirePermission.mockImplementationOnce(() => {
        throw new Error('denied');
      });
      await expect(service.createSshKey({ name: 'n', key: ED25519_KEY })).rejects.toThrow('denied');
      expect(mockContext.requirePermission).toHaveBeenCalledWith('ssh-key', 'create');
      expect(mockPrisma.sshKeys.findFirst).not.toHaveBeenCalled();
    });
  });
});
