import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { Buffer } from 'node:buffer';
import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { ZoneRegistrationTokenGuard } from '../guards/zone-registration-token.guard';
import { ZoneCryptoRepository } from '../zone-crypto.repository';

const ZONE_ID = '00000000-0000-4000-8000-000000000001';
const TOKEN = 'valid-registration-token';
const ZONE_PUB_HEX = 'f'.repeat(64);

function macFor(token: string, zoneId: string, zonePubHex: string): string {
  return createHmac('sha256', Buffer.from(token, 'utf8'))
    .update(zoneId, 'utf8')
    .update(Buffer.from(zonePubHex, 'hex'))
    .digest('hex');
}

function tokenRowFor(token: string, zoneId: string) {
  return { id: 'tok-1', zoneId, tokenHash: createHash('sha256').update(token, 'utf8').digest('hex') };
}

function makeContext(body: unknown, params: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ body, params }),
    }),
  } as unknown as ExecutionContext;
}

describe('ZoneRegistrationTokenGuard', () => {
  let guard: ZoneRegistrationTokenGuard;
  let mockRepo: { findTokenByHash: Mock };

  beforeEach(async () => {
    mockRepo = { findTokenByHash: vi.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [ZoneRegistrationTokenGuard, { provide: ZoneCryptoRepository, useValue: mockRepo }],
    }).compile();
    guard = module.get(ZoneRegistrationTokenGuard);
  });

  it('rejects an oversized registration_token before any hashing or lookup', async () => {
    const body = { registration_token: 'a'.repeat(257), zone_pub: 'f'.repeat(64), mac: '0'.repeat(64) };

    await expect(guard.canActivate(makeContext(body, { zoneId: ZONE_ID }))).rejects.toThrow(UnauthorizedException);
    expect(mockRepo.findTokenByHash).not.toHaveBeenCalled();
  });

  it('lets a max-length (256-char) token through the length gate to lookup', async () => {
    mockRepo.findTokenByHash.mockResolvedValue(null);
    const body = { registration_token: 'a'.repeat(256), zone_pub: 'f'.repeat(64), mac: '0'.repeat(64) };

    await expect(guard.canActivate(makeContext(body, { zoneId: ZONE_ID }))).rejects.toThrow(UnauthorizedException);
    expect(mockRepo.findTokenByHash).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['zoneId', { zoneId: null }, { registration_token: TOKEN, zone_pub: ZONE_PUB_HEX, mac: '0'.repeat(64) }],
    ['registration_token', { zoneId: ZONE_ID }, { zone_pub: ZONE_PUB_HEX, mac: '0'.repeat(64) }],
    ['zone_pub', { zoneId: ZONE_ID }, { registration_token: TOKEN, mac: '0'.repeat(64) }],
    ['mac', { zoneId: ZONE_ID }, { registration_token: TOKEN, zone_pub: ZONE_PUB_HEX }],
  ])('rejects a request missing %s before any lookup', async (_field, params, body) => {
    await expect(guard.canActivate(makeContext(body, params))).rejects.toThrow(UnauthorizedException);
    expect(mockRepo.findTokenByHash).not.toHaveBeenCalled();
  });

  it('rejects a non-hex zone_pub before any lookup', async () => {
    const body = { registration_token: TOKEN, zone_pub: 'z'.repeat(64), mac: '0'.repeat(64) };

    await expect(guard.canActivate(makeContext(body, { zoneId: ZONE_ID }))).rejects.toThrow(UnauthorizedException);
    expect(mockRepo.findTokenByHash).not.toHaveBeenCalled();
  });

  it('rejects a non-hex mac before any lookup', async () => {
    const body = { registration_token: TOKEN, zone_pub: ZONE_PUB_HEX, mac: 'z'.repeat(64) };

    await expect(guard.canActivate(makeContext(body, { zoneId: ZONE_ID }))).rejects.toThrow(UnauthorizedException);
    expect(mockRepo.findTokenByHash).not.toHaveBeenCalled();
  });

  it('rejects a token bound to a different zone', async () => {
    const otherZone = '00000000-0000-4000-8000-000000000002';
    mockRepo.findTokenByHash.mockResolvedValue(tokenRowFor(TOKEN, otherZone));
    const body = { registration_token: TOKEN, zone_pub: ZONE_PUB_HEX, mac: macFor(TOKEN, ZONE_ID, ZONE_PUB_HEX) };

    await expect(guard.canActivate(makeContext(body, { zoneId: ZONE_ID }))).rejects.toThrow(UnauthorizedException);
    expect(mockRepo.findTokenByHash).toHaveBeenCalledTimes(1);
  });

  it('rejects a request whose MAC is wrong but correctly sized', async () => {
    mockRepo.findTokenByHash.mockResolvedValue(tokenRowFor(TOKEN, ZONE_ID));
    const body = { registration_token: TOKEN, zone_pub: ZONE_PUB_HEX, mac: '0'.repeat(64) };

    await expect(guard.canActivate(makeContext(body, { zoneId: ZONE_ID }))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a length-mismatched (short hex) mac before any lookup', async () => {
    const body = { registration_token: TOKEN, zone_pub: ZONE_PUB_HEX, mac: 'aa'.repeat(16) };

    await expect(guard.canActivate(makeContext(body, { zoneId: ZONE_ID }))).rejects.toThrow(UnauthorizedException);
    expect(mockRepo.findTokenByHash).not.toHaveBeenCalled();
  });

  it('returns true for a valid request whose MAC matches', async () => {
    mockRepo.findTokenByHash.mockResolvedValue(tokenRowFor(TOKEN, ZONE_ID));
    const body = { registration_token: TOKEN, zone_pub: ZONE_PUB_HEX, mac: macFor(TOKEN, ZONE_ID, ZONE_PUB_HEX) };

    await expect(guard.canActivate(makeContext(body, { zoneId: ZONE_ID }))).resolves.toBe(true);
    expect(mockRepo.findTokenByHash).toHaveBeenCalledTimes(1);
  });
});
