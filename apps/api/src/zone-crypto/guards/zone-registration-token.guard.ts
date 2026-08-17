import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Buffer } from 'node:buffer';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { ZoneCryptoRepository } from '../zone-crypto.repository';

const HEX_64_CHARS = /^[0-9a-f]{64}$/;

const MAX_REGISTRATION_TOKEN_LENGTH = 256;

interface EnrollRequestBody {
  registration_token?: unknown;
  zone_pub?: unknown;
  mac?: unknown;
}

interface EnrollRequestParams {
  zoneId?: unknown;
}

@Injectable()
export class ZoneRegistrationTokenGuard implements CanActivate {
  constructor(private readonly repository: ZoneCryptoRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{ body: EnrollRequestBody; params: EnrollRequestParams }>();

    const zoneId = typeof request.params?.zoneId === 'string' ? request.params.zoneId : null;
    const body = request.body ?? {};
    const rawToken =
      typeof body.registration_token === 'string' && body.registration_token.length <= MAX_REGISTRATION_TOKEN_LENGTH
        ? body.registration_token
        : null;
    const zonePublicKeyHex = typeof body.zone_pub === 'string' ? body.zone_pub : null;
    const macHex = typeof body.mac === 'string' ? body.mac : null;

    if (!zoneId || !rawToken || !zonePublicKeyHex || !macHex) {
      throw new UnauthorizedException('Invalid registration token');
    }

    if (!HEX_64_CHARS.test(zonePublicKeyHex) || !HEX_64_CHARS.test(macHex)) {
      throw new UnauthorizedException('Invalid registration token');
    }

    const tokenHash = createHash('sha256').update(rawToken, 'utf8').digest('hex');
    const tokenRow = await this.repository.findTokenByHash(tokenHash);
    if (!tokenRow || tokenRow.zoneId !== zoneId) {
      throw new UnauthorizedException('Invalid registration token');
    }

    const tokenBytes = Buffer.from(rawToken, 'utf8');
    const zonePublicKey = Buffer.from(zonePublicKeyHex, 'hex');
    const expected = createHmac('sha256', tokenBytes).update(zoneId, 'utf8').update(zonePublicKey).digest();
    const presented = Buffer.from(macHex, 'hex');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      throw new UnauthorizedException('Invalid registration token');
    }

    return true;
  }
}
