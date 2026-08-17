import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { contract } from '@repo/api-client';
import { Buffer } from 'node:buffer';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';
import type { z } from 'zod';

import { ZoneCryptoConfig } from './zone-crypto.config';
import { TokenConsumeRaceError, ZoneCryptoRepository } from './zone-crypto.repository';

type EnrollRequestBody = z.infer<typeof contract.enrollZone.body>;
type EnrollSuccessBody = z.infer<(typeof contract.enrollZone.responses)[200]>;

export interface EnrollAuditContext {
  ip: string;
}

type SuccessPath = 'fresh' | 'idempotent' | 'race-recovered';

@Injectable()
export class ZoneCryptoService {
  constructor(
    private readonly config: ZoneCryptoConfig,
    private readonly repository: ZoneCryptoRepository,
    @Logger(ZoneCryptoService.name) private readonly logger: LoggerService,
  ) {}

  async enrollZone(zoneId: string, request: EnrollRequestBody, audit: EnrollAuditContext): Promise<EnrollSuccessBody> {
    let hubPublicKey: Buffer;
    try {
      hubPublicKey = this.requireConfigured();
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        this.logRejection({ zoneId, reason: 'not_configured', ip: audit.ip });
      }
      throw error;
    }

    const zonePublicKey = Buffer.from(request.zone_pub, 'hex');
    const tokenBytes = Buffer.from(request.registration_token, 'utf8');
    const tokenHash = createHash('sha256').update(request.registration_token, 'utf8').digest('hex');

    const tokenRow = await this.repository.findTokenByHash(tokenHash);
    if (!tokenRow || tokenRow.zoneId !== zoneId) {
      // Same response for not-found and wrong-zone — don't disclose which.
      this.logRejection({ zoneId, reason: 'invalid_token', ip: audit.ip });
      throw new UnauthorizedException('Invalid registration token');
    }

    // MAC check must run BEFORE the consume/expiry branches — a bad-MAC caller gets a uniform 401 so token state can't be probed.
    if (!this.verifyRequestMac({ tokenBytes, zoneId, zonePublicKey, presentedMacHex: request.mac })) {
      this.logRejection({ zoneId, tokenId: tokenRow.id, reason: 'invalid_mac_post_guard', ip: audit.ip });
      throw new UnauthorizedException('Invalid registration token');
    }

    if (tokenRow.consumedAt) {
      if (tokenRow.consumedZonePub && Buffer.from(tokenRow.consumedZonePub).equals(zonePublicKey)) {
        this.logSuccess({ zoneId, tokenId: tokenRow.id, zonePublicKey, path: 'idempotent', ip: audit.ip });
        return this.buildResponse({ tokenBytes, zoneId, zonePublicKey, hubPublicKey });
      }
      this.logRejection({ zoneId, tokenId: tokenRow.id, reason: 'zone_pub_mismatch', ip: audit.ip });
      throw new ConflictException('Registration token already consumed with a different zone_pub');
    }

    if (tokenRow.expiresAt <= new Date()) {
      this.logRejection({ zoneId, tokenId: tokenRow.id, reason: 'expired', ip: audit.ip });
      throw new HttpException('Registration token has expired', HttpStatus.GONE);
    }

    try {
      await this.repository.consumeTokenAndUpsertEnrollment({
        tokenId: tokenRow.id,
        zoneId,
        zonePublicKey,
      });
    } catch (error) {
      if (error instanceof TokenConsumeRaceError) {
        return this.handleConsumeRace({ tokenHash, tokenBytes, zoneId, zonePublicKey, hubPublicKey, audit });
      }
      throw error;
    }

    this.logSuccess({ zoneId, tokenId: tokenRow.id, zonePublicKey, path: 'fresh', ip: audit.ip });
    return this.buildResponse({ tokenBytes, zoneId, zonePublicKey, hubPublicKey });
  }

  private requireConfigured(): Buffer {
    if (!this.config.isAvailable || !this.config.publicKey) {
      throw new ServiceUnavailableException(
        'Zone enrollment is not configured on this hub (BROKKR_HUB_PRIVATE_KEY unset)',
      );
    }
    return this.config.publicKey;
  }

  private async handleConsumeRace(args: {
    tokenHash: string;
    tokenBytes: Buffer;
    zoneId: string;
    zonePublicKey: Buffer;
    hubPublicKey: Buffer;
    audit: EnrollAuditContext;
  }): Promise<EnrollSuccessBody> {
    const refetched = await this.repository.findTokenByHash(args.tokenHash);
    if (refetched?.consumedZonePub && Buffer.from(refetched.consumedZonePub).equals(args.zonePublicKey)) {
      this.logSuccess({
        zoneId: args.zoneId,
        tokenId: refetched.id,
        zonePublicKey: args.zonePublicKey,
        path: 'race-recovered',
        ip: args.audit.ip,
      });
      return this.buildResponse({
        tokenBytes: args.tokenBytes,
        zoneId: args.zoneId,
        zonePublicKey: args.zonePublicKey,
        hubPublicKey: args.hubPublicKey,
      });
    }
    this.logRejection({
      zoneId: args.zoneId,
      tokenId: refetched?.id,
      reason: 'race_zone_pub_mismatch',
      ip: args.audit.ip,
    });
    throw new ConflictException('Registration token already consumed by a concurrent request');
  }

  private verifyRequestMac(args: {
    tokenBytes: Buffer;
    zoneId: string;
    zonePublicKey: Buffer;
    presentedMacHex: string;
  }): boolean {
    const expected = this.computeRequestMac({
      tokenBytes: args.tokenBytes,
      zoneId: args.zoneId,
      zonePublicKey: args.zonePublicKey,
    });
    const presented = Buffer.from(args.presentedMacHex, 'hex');
    if (presented.length !== expected.length) {
      return false;
    }
    return timingSafeEqual(presented, expected);
  }

  private computeRequestMac(args: { tokenBytes: Buffer; zoneId: string; zonePublicKey: Buffer }): Buffer {
    return createHmac('sha256', args.tokenBytes).update(args.zoneId, 'utf8').update(args.zonePublicKey).digest();
  }

  private computeResponseMac(args: {
    tokenBytes: Buffer;
    zoneId: string;
    zonePublicKey: Buffer;
    hubPublicKey: Buffer;
  }): Buffer {
    return createHmac('sha256', args.tokenBytes)
      .update(args.zoneId, 'utf8')
      .update(args.zonePublicKey)
      .update(args.hubPublicKey)
      .digest();
  }

  private buildResponse(args: {
    tokenBytes: Buffer;
    zoneId: string;
    zonePublicKey: Buffer;
    hubPublicKey: Buffer;
  }): EnrollSuccessBody {
    const mac = this.computeResponseMac(args);
    return {
      hub_pub: args.hubPublicKey.toString('hex'),
      mac: mac.toString('hex'),
    };
  }

  private logSuccess(args: {
    zoneId: string;
    tokenId: string;
    zonePublicKey: Buffer;
    path: SuccessPath;
    ip: string;
  }): void {
    this.logger.log(
      `Zone enrollment ok zone=${args.zoneId} token=${args.tokenId} zone_pub=${args.zonePublicKey.toString('hex')} path=${args.path} ip=${args.ip}`,
    );
  }

  private logRejection(args: { zoneId: string; tokenId?: string; reason: string; ip: string }): void {
    const tokenPart = args.tokenId ? ` token=${args.tokenId}` : '';
    this.logger.log(`Zone enrollment rejected zone=${args.zoneId}${tokenPart} reason=${args.reason} ip=${args.ip}`);
  }
}
