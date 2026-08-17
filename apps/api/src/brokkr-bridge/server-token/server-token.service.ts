import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { ConfigAtomWriter, serverToken } from 'src/common/redis';
import { DeviceTokensService } from 'src/device-tokens/device-tokens.service';
import { LoggerService } from 'src/logger/logger.service';
import { z } from 'zod';
import { DeviceContextService, DeviceZoneContext } from '../device-context.service';

/** Minting rotates: the hub stores only HMAC hashes, so a render-on-miss must mint a successor. */
export const ServerTokenSchema = z
  .object({
    brokkr_live_token: z.string().min(1).describe('Opaque bearer token plaintext.'),
    endpoint: z.string().min(1).describe('Hub phone-home endpoint the token authenticates against.'),
    exp: z.number().int().describe('Unix epoch seconds when the token expires.'),
  })
  .strict();
export type ServerTokenAtom = z.infer<typeof ServerTokenSchema>;

// 24h bounds leakage if the atom escapes Redis while giving the spoke a long consumption window.
export const TTL_SERVER_TOKEN_SECONDS = 86_400;

@Injectable()
export class ServerTokenService {
  constructor(
    private readonly deviceContext: DeviceContextService,
    private readonly deviceTokens: DeviceTokensService,
    private readonly atomWriter: ConfigAtomWriter,
    @Logger(ServerTokenService.name) private readonly logger: LoggerService,
  ) {}

  async mintForCtx(ctx: DeviceZoneContext): Promise<ServerTokenAtom> {
    const issued = await this.deviceTokens.issueBrokkrLiveToken({
      deviceId: ctx.device.id,
      issuedBy: 'system',
    });
    if (!issued.material) {
      throw new InternalServerErrorException(`Brokkr Live token mint returned no material for device ${ctx.device.id}`);
    }

    return {
      brokkr_live_token: issued.material.brokkr_live_token,
      endpoint: issued.material.endpoint,
      exp: issued.material.exp,
    };
  }

  async writeAtomForCtx(
    ctx: DeviceZoneContext,
    atom: ServerTokenAtom,
    opts: { requestId?: string | null } = {},
  ): Promise<void> {
    await this.atomWriter.writeAtomJson(
      ctx.zoneId,
      serverToken(ctx.device.id),
      atom,
      ServerTokenSchema,
      TTL_SERVER_TOKEN_SECONDS,
      { request_id: opts.requestId ?? null },
    );
    this.logger.log(`Wrote server-token atom for device ${ctx.device.id} (zone=${ctx.zoneId})`);
  }

  async writeForDevice(deviceId: string, opts: { requestId?: string | null } = {}): Promise<ServerTokenAtom> {
    const ctx = await this.deviceContext.resolveZoneContext(deviceId);
    const atom = await this.mintForCtx(ctx);
    await this.writeAtomForCtx(ctx, atom, opts);
    return atom;
  }

  async writeAtomBestEffort(
    ctx: DeviceZoneContext,
    atom: ServerTokenAtom,
    opts: { requestId: string; opLabel: string },
  ): Promise<void> {
    try {
      await this.writeAtomForCtx(ctx, atom, { requestId: opts.requestId });
    } catch (error) {
      this.logger.warn(
        `Failed to write server-token atom for ${opts.opLabel} of device ${ctx.device.id}: ${getErrorMessage(error)}`,
        opts.requestId,
      );
    }
  }

  async writeForDeviceBestEffort(deviceId: string, opts: { requestId: string; opLabel: string }): Promise<void> {
    try {
      await this.writeForDevice(deviceId, { requestId: opts.requestId });
    } catch (error) {
      this.logger.warn(
        `Failed to write server-token atom for ${opts.opLabel} of device ${deviceId}: ${getErrorMessage(error)}`,
        opts.requestId,
      );
    }
  }
}
