import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { ConfigAtomWriter, deployToken, serverToken } from 'src/common/redis';
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

export const DeployTokenSchema = z
  .object({
    deployment_os_token: z.string().min(1).describe('Opaque DEPLOYMENT_OS bearer token plaintext.'),
    endpoint: z.string().min(1).describe('Hub phone-home endpoint the token authenticates against.'),
  })
  .strict();
export type DeployTokenAtom = z.infer<typeof DeployTokenSchema>;

// 24h bounds leakage if the atom escapes Redis while giving the spoke a long consumption window.
export const TTL_SERVER_TOKEN_SECONDS = 86_400;
export const TTL_DEPLOY_TOKEN_SECONDS = TTL_SERVER_TOKEN_SECONDS;

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
    await this.writeAtom(ctx, atom, {
      key: serverToken(ctx.device.id),
      schema: ServerTokenSchema,
      ttl: TTL_SERVER_TOKEN_SECONDS,
      logLabel: 'server-token',
      requestId: opts.requestId,
    });
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
    await this.bestEffort('server-token', ctx.device.id, opts, () =>
      this.writeAtomForCtx(ctx, atom, { requestId: opts.requestId }),
    );
  }

  async writeForDeviceBestEffort(deviceId: string, opts: { requestId: string; opLabel: string }): Promise<void> {
    await this.bestEffort('server-token', deviceId, opts, () =>
      this.writeForDevice(deviceId, { requestId: opts.requestId }),
    );
  }

  async mintDeployForCtx(ctx: DeviceZoneContext): Promise<DeployTokenAtom> {
    const issued = await this.deviceTokens.issueDeploymentOsToken({
      deviceId: ctx.device.id,
      issuedBy: 'system',
    });
    if (!issued.material) {
      throw new InternalServerErrorException(
        `Deployment OS token mint returned no material for device ${ctx.device.id}`,
      );
    }

    return {
      deployment_os_token: issued.material.deployment_os_token,
      endpoint: issued.material.endpoint,
    };
  }

  async writeDeployAtomForCtx(
    ctx: DeviceZoneContext,
    atom: DeployTokenAtom,
    opts: { requestId?: string | null } = {},
  ): Promise<void> {
    await this.writeAtom(ctx, atom, {
      key: deployToken(ctx.device.id),
      schema: DeployTokenSchema,
      ttl: TTL_DEPLOY_TOKEN_SECONDS,
      logLabel: 'deploy-token',
      requestId: opts.requestId,
    });
  }

  async writeDeployAtomBestEffort(
    ctx: DeviceZoneContext,
    atom: DeployTokenAtom,
    opts: { requestId: string; opLabel: string },
  ): Promise<void> {
    await this.bestEffort('deploy-token', ctx.device.id, opts, () =>
      this.writeDeployAtomForCtx(ctx, atom, { requestId: opts.requestId }),
    );
  }

  private async writeAtom<TAtom>(
    ctx: DeviceZoneContext,
    atom: TAtom,
    opts: { key: string; schema: z.ZodType<TAtom>; ttl: number; logLabel: string; requestId?: string | null },
  ): Promise<void> {
    const result = await this.atomWriter.writeAtomJson(ctx.zoneId, opts.key, atom, opts.schema, opts.ttl, {
      request_id: opts.requestId ?? null,
    });
    const target = `for device ${ctx.device.id} (zone=${ctx.zoneId})`;
    if (result.written) {
      this.logger.log(`Wrote ${opts.logLabel} atom ${target}`);
      return;
    }
    this.logger.debug(`Skipped stale ${opts.logLabel} atom write ${target}`);
  }

  private async bestEffort(
    logLabel: string,
    deviceId: string,
    opts: { requestId: string; opLabel: string },
    write: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await write();
    } catch (error) {
      this.logger.warn(
        `Failed to write ${logLabel} atom for ${opts.opLabel} of device ${deviceId}: ${getErrorMessage(error)}`,
        opts.requestId,
      );
    }
  }
}
