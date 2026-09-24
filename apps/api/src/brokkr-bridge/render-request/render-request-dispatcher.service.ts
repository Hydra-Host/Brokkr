import { BadRequestException, Injectable, NotImplementedException } from '@nestjs/common';
import { DeviceSecretActorType, DeviceSecretKind, DeviceSecretPurpose } from '@repo/database';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import {
  ConfigAtomWriter,
  NETPLAN_LIVE_TTL_SECONDS,
  TTL_NEGATIVE_CACHE_SECONDS,
  deployToken,
  deviceSecret,
  netplanConfig,
  serverToken,
} from 'src/common/redis';
import { DeviceSecretAtomPublisher } from 'src/device-secret/device-secret-atom-publisher.service';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { DeviceContextService, DeviceZoneContext } from '../device-context.service';
import { DeviceRecordPublisher } from '../device-record/device-record-publisher.service';
import { DeviceResolverService } from '../device-record/device-resolver.service';
import { NetplanAtomSchema } from '../netplan/netplan-atom.schema';
import { NetplanPublisherService } from '../netplan/netplan-publisher.service';
import { ServerTokenService } from '../server-token/server-token.service';
import {
  ipxeIdentifierBundleSchema,
  type IpxeIdentifierBundle,
  type RenderDomain,
  type RenderRequest,
} from '../types/render-request.types';

@Injectable()
export class RenderRequestDispatcher {
  constructor(
    private readonly serverTokenService: ServerTokenService,
    private readonly deviceRecordPublisher: DeviceRecordPublisher,
    private readonly deviceResolver: DeviceResolverService,
    private readonly netplanPublisher: NetplanPublisherService,
    private readonly deviceContext: DeviceContextService,
    private readonly deviceSecretPublisher: DeviceSecretAtomPublisher,
    private readonly atomWriter: ConfigAtomWriter,
    private readonly prisma: PrismaClient,
    @Logger(RenderRequestDispatcher.name) private readonly logger: LoggerService,
  ) {}

  async dispatch(req: RenderRequest): Promise<void> {
    const domain: RenderDomain = req.domain;
    switch (domain) {
      case 'server_token':
        return this.dispatchServerToken(req);
      case 'deploy_token':
        return this.dispatchDeployToken(req);
      case 'device_record':
        return this.dispatchDeviceRecord(req);
      case 'netplan':
        return this.dispatchNetplan(req);
      case 'device_secret':
        return this.dispatchDeviceSecret(req);
      default: {
        const exhaustive: never = domain;
        throw new NotImplementedException(
          `render.request domain '${String(exhaustive)}' is not yet handled (request=${req.request_id})`,
        );
      }
    }
  }

  private async dispatchServerToken(req: RenderRequest): Promise<void> {
    await this.dispatchTokenRender(req, {
      keyFn: serverToken,
      render: async (ctx) => {
        const atom = await this.serverTokenService.mintForCtx(ctx);
        await this.serverTokenService.writeAtomForCtx(ctx, atom, { requestId: req.request_id });
      },
    });
  }

  private async dispatchDeployToken(req: RenderRequest): Promise<void> {
    await this.dispatchTokenRender(req, {
      keyFn: deployToken,
      render: async (ctx) => {
        const atom = await this.serverTokenService.mintDeployForCtx(ctx);
        await this.serverTokenService.writeDeployAtomForCtx(ctx, atom, { requestId: req.request_id });
      },
    });
  }

  private async dispatchTokenRender(
    req: RenderRequest,
    opts: {
      keyFn: (deviceId: string) => string;
      render: (ctx: DeviceZoneContext) => Promise<void>;
    },
  ): Promise<void> {
    const deviceId = req.params?.entity_id;
    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      throw new BadRequestException(
        `render.request domain '${req.domain}' missing string params.entity_id (request=${req.request_id})`,
      );
    }

    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { id: true },
    });
    if (!device) {
      await this.writeTokenError(req, deviceId, `no Device with id=${deviceId}`, opts.keyFn);
      throw new BadRequestException(
        `render.request domain '${req.domain}' no Device with id=${deviceId} (request=${req.request_id})`,
      );
    }

    try {
      const ctx = await this.deviceContext.resolveZoneContext(device.id);
      if (ctx.zoneId !== req.zone_id) {
        const reason = `device ${device.id} resolves to zone ${ctx.zoneId} but bridge polls zone ${req.zone_id}`;
        this.logger.error(
          `render.request ${req.domain} zone mismatch: ${reason} (request=${req.request_id}) — writing negative-cache envelope under polling zone`,
          undefined,
          req.request_id,
        );
        await this.writeTokenError(req, device.id, reason, opts.keyFn);
        return;
      }

      await opts.render(ctx);
    } catch (error) {
      const reason = getErrorMessage(error);
      this.logger.warn(
        `Failed to render ${req.domain} for device ${device.id} (request=${req.request_id}): ${reason} — writing negative-cache envelope`,
        req.request_id,
      );
      await this.writeTokenError(req, device.id, reason, opts.keyFn);
      return;
    }
    this.logger.log(
      `Rendered ${req.domain} atom for device ${device.id} on demand (request=${req.request_id}, reason=${req.reason ?? 'unspecified'})`,
    );
  }

  private async dispatchDeviceRecord(req: RenderRequest): Promise<void> {
    const params = req.params ?? {};
    const rawEntityId = params.entity_id;
    const rawIdentifiers = params.identifiers;
    const rawBuildarch = params.buildarch;

    if (rawEntityId !== undefined) {
      if (typeof rawEntityId !== 'string' || rawEntityId.length === 0) {
        throw new BadRequestException(
          `render.request domain 'device_record' params.entity_id must be a non-empty string (request=${req.request_id})`,
        );
      }

      const device = await this.prisma.device.findUnique({
        where: { id: rawEntityId, deletedAt: null },
        select: { id: true },
      });
      if (!device) {
        this.logger.warn(
          `render.request domain 'device_record' no real Device with id=${rawEntityId}; ` +
            `treating as placeholder — bridge must resubmit with identifiers (request=${req.request_id})`,
        );
        throw new BadRequestException(
          `render.request domain 'device_record' cannot re-render id ${rawEntityId} without identifiers (request=${req.request_id})`,
        );
      }
      const result = await this.deviceRecordPublisher.writeForDevice(device.id, { requestId: req.request_id });
      if (!result.written) {
        this.logger.warn(
          `Skipped device_record publish for device ${device.id} on demand: ${result.reason ?? 'unknown'} ` +
            `(request=${req.request_id}, reason=${req.reason ?? 'unspecified'})`,
          req.request_id,
        );
        return;
      }
      this.logger.log(
        `Rendered device_record atom for device ${device.id} on demand (request=${req.request_id}, reason=${req.reason ?? 'unspecified'})`,
      );
      return;
    }

    if (rawIdentifiers !== undefined) {
      const parsed = ipxeIdentifierBundleSchema.safeParse(rawIdentifiers);
      if (!parsed.success) {
        throw new BadRequestException(
          `render.request domain 'device_record' params.identifiers failed validation (request=${req.request_id}): ${parsed.error.message}`,
        );
      }
      const bundle: IpxeIdentifierBundle = parsed.data;
      const buildarch = typeof rawBuildarch === 'string' && rawBuildarch.length > 0 ? rawBuildarch : null;

      const resolution = await this.deviceResolver.resolve(bundle);
      if (resolution.kind === 'known') {
        const result = await this.deviceRecordPublisher.writeForDevice(resolution.device.id, {
          requestId: req.request_id,
        });
        if (!result.written) {
          this.logger.warn(
            `Skipped device_record publish for device ${resolution.device.id} (matched on ${resolution.matchedOn}) on demand: ${result.reason ?? 'unknown'} ` +
              `(request=${req.request_id}, reason=${req.reason ?? 'unspecified'})`,
            req.request_id,
          );
          return;
        }
        this.logger.log(
          `Rendered device_record atom for device ${resolution.device.id} (matched on ${resolution.matchedOn}) on demand (request=${req.request_id}, reason=${req.reason ?? 'unspecified'})`,
        );
        return;
      }

      const { id: placeholderId, result } = await this.deviceRecordPublisher.writePlaceholder(bundle, {
        buildarch,
        zoneId: req.zone_id,
        requestId: req.request_id,
      });
      if (!result.written) {
        this.logger.warn(
          `Skipped placeholder device_record mint (id=${placeholderId}, zone=${req.zone_id}) on demand: ${result.reason ?? 'unknown'} ` +
            `(request=${req.request_id}, reason=${req.reason ?? 'unspecified'})`,
          req.request_id,
        );
        return;
      }
      this.logger.log(
        `Minted placeholder device_record (id=${placeholderId}, zone=${req.zone_id}) on demand (request=${req.request_id}, reason=${req.reason ?? 'unspecified'})`,
      );
      return;
    }

    throw new BadRequestException(
      `render.request domain 'device_record' missing both params.entity_id and params.identifiers (request=${req.request_id})`,
    );
  }

  private async dispatchNetplan(req: RenderRequest): Promise<void> {
    const deviceId = req.params?.entity_id;
    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      throw new BadRequestException(
        `render.request domain 'netplan' missing string params.entity_id (request=${req.request_id})`,
      );
    }

    let yaml: string;
    try {
      yaml = await this.netplanPublisher.renderLiveNetplan({
        deviceId,
        jobId: req.request_id,
      });
    } catch (error) {
      const reason = getErrorMessage(error);
      const ttl = TTL_NEGATIVE_CACHE_SECONDS;
      this.logger.warn(
        `Failed to render live netplan for device ${deviceId} (request=${req.request_id}): ${reason} — writing negative-cache envelope (ttl=${ttl}s)`,
        req.request_id,
      );
      await this.atomWriter.writeAtomError(req.zone_id, netplanConfig(deviceId, 'live'), reason, ttl, {
        request_id: req.request_id,
      });
      return;
    }

    if (yaml.trim() === '') {
      const reason = 'empty_render';
      this.logger.warn(
        `Live netplan renderer returned empty YAML for device ${deviceId} (request=${req.request_id}) — writing negative-cache envelope`,
        req.request_id,
      );
      await this.atomWriter.writeAtomError(
        req.zone_id,
        netplanConfig(deviceId, 'live'),
        reason,
        TTL_NEGATIVE_CACHE_SECONDS,
        { request_id: req.request_id },
      );
      return;
    }

    const writeResult = await this.atomWriter.writeAtomJson(
      req.zone_id,
      netplanConfig(deviceId, 'live'),
      { yaml },
      NetplanAtomSchema,
      NETPLAN_LIVE_TTL_SECONDS,
      { request_id: req.request_id },
    );
    if (!writeResult.written) {
      this.logger.log(
        `Skipped netplan atom write (${writeResult.reason}) for device ${deviceId} (request=${req.request_id})`,
        req.request_id,
      );
      return;
    }
    this.logger.log(
      `Rendered live netplan atom for device ${deviceId} on demand (request=${req.request_id}, reason=${req.reason ?? 'unspecified'})`,
      req.request_id,
    );
  }

  private async dispatchDeviceSecret(req: RenderRequest): Promise<void> {
    const params = req.params ?? {};
    const deviceId = params.entity_id;
    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      throw new BadRequestException(
        `render.request domain 'device_secret' missing string params.entity_id (request=${req.request_id})`,
      );
    }

    const purpose = this.parsePurpose(params.purpose, req);
    const kind = this.parseKind(params.kind, req);

    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { id: true },
    });
    if (!device) {
      await this.writeDeviceSecretError(req, deviceId, purpose, kind, `no Device with id=${deviceId}`);
      throw new BadRequestException(
        `render.request domain 'device_secret' no Device with id=${deviceId} (request=${req.request_id})`,
      );
    }

    let result: { written: boolean; reason?: 'no-secret' | 'stale' };
    try {
      const ctx = await this.deviceContext.resolveZoneContext(device.id);
      if (ctx.zoneId !== req.zone_id) {
        const reason = `device ${device.id} resolves to zone ${ctx.zoneId} but bridge polls zone ${req.zone_id}`;
        this.logger.error(
          `render.request device_secret zone mismatch: ${reason} (request=${req.request_id}) — writing negative-cache envelope under polling zone`,
          undefined,
          req.request_id,
        );
        await this.writeDeviceSecretError(req, device.id, purpose, kind, reason);
        return;
      }

      result = await this.deviceSecretPublisher.publishCurrent(
        device.id,
        purpose,
        kind,
        { type: DeviceSecretActorType.BRIDGE, id: req.bridge_id },
        { requestId: req.request_id },
      );
    } catch (error) {
      const reason = getErrorMessage(error);
      this.logger.warn(
        `Failed to render device_secret for device ${device.id} ${purpose}/${kind} (request=${req.request_id}): ${reason} — writing negative-cache envelope`,
        req.request_id,
      );
      await this.writeDeviceSecretError(req, device.id, purpose, kind, reason);
      return;
    }

    if (!result.written) {
      if (result.reason === 'no-secret') {
        this.logger.warn(
          `No live device_secret for device ${device.id} ${purpose}/${kind} (request=${req.request_id}) — writing negative-cache envelope`,
          req.request_id,
        );
        await this.writeDeviceSecretError(req, device.id, purpose, kind, 'no-secret');
        return;
      }
      // 'stale': a newer atom already won the last-newer-wins race — leave it.
      this.logger.log(
        `Skipped device_secret atom write (${result.reason ?? 'not-written'}) for device ${device.id} ${purpose}/${kind} (request=${req.request_id})`,
        req.request_id,
      );
      return;
    }
    this.logger.log(
      `Rendered device_secret atom for device ${device.id} ${purpose}/${kind} on demand (request=${req.request_id}, reason=${req.reason ?? 'unspecified'})`,
    );
  }

  private parsePurpose(raw: unknown, req: RenderRequest): DeviceSecretPurpose {
    if (raw === undefined || raw === null) return DeviceSecretPurpose.BMC;
    const match = Object.values(DeviceSecretPurpose).find((value) => value === raw);
    if (match === undefined) {
      throw new BadRequestException(
        `render.request domain 'device_secret' invalid params.purpose '${String(raw)}' (request=${req.request_id})`,
      );
    }
    return match;
  }

  private parseKind(raw: unknown, req: RenderRequest): DeviceSecretKind {
    if (raw === undefined || raw === null) return DeviceSecretKind.USER;
    const match = Object.values(DeviceSecretKind).find((value) => value === raw);
    if (match === undefined) {
      throw new BadRequestException(
        `render.request domain 'device_secret' invalid params.kind '${String(raw)}' (request=${req.request_id})`,
      );
    }
    return match;
  }

  private async writeDeviceSecretError(
    req: RenderRequest,
    deviceId: string,
    purpose: DeviceSecretPurpose,
    kind: DeviceSecretKind,
    reason: string,
  ): Promise<void> {
    await this.atomWriter.writeAtomError(
      req.zone_id,
      deviceSecret(deviceId, purpose, kind),
      reason,
      TTL_NEGATIVE_CACHE_SECONDS,
      { request_id: req.request_id },
    );
  }

  private async writeTokenError(
    req: RenderRequest,
    deviceId: string,
    reason: string,
    keyFn: (deviceId: string) => string,
  ): Promise<void> {
    await this.atomWriter.writeAtomError(req.zone_id, keyFn(deviceId), reason, TTL_NEGATIVE_CACHE_SECONDS, {
      request_id: req.request_id,
    });
  }
}
