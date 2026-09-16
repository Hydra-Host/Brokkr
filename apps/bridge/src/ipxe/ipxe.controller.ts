import { Body, Controller, Get, HttpStatus, Inject, Optional, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ResultsService } from '../bullmq/results.service';
import { getErrorMessage } from '../common/error-utils';
import { extractClientIpFromRequest } from '../common/job-id.service';
import { extractJobIdFromRequest } from '../common/middleware/job-id.middleware';
import { BULLMQ_RESULTS_SERVICE } from '../composition/composition-tokens';
import { isPlaceholder } from '../device-record/device-record.schema';
import { isResolveOutcome, ResolveOutcome } from '../device-record/device-record.service';
import { logError, logInfo, logWarning } from '../logger/logger.service';

import { extractIdentifiers, sanitizeChainJobId } from './chain.helpers';
import { chainUnreachableQuerySchema, ipxeChainBodySchema } from './chain.schema';
import { ChainService } from './chain.service';
import { IpxeServiceError } from './ipxe-errors';
import type { RenderRequest } from './ipxe-renderer.helpers';

export const IPXE_PENDING_DEVICE_REGISTRAR = Symbol('IpxePendingDeviceRegistrar');

const PROVISIONING_PHASE_STATUSES: ReadonlySet<string> = new Set(['provisioning', 'staged']);

function isProvisioningPhase(status: string | null | undefined): boolean {
  return typeof status === 'string' && PROVISIONING_PHASE_STATUSES.has(status.toLowerCase());
}

export interface PendingDeviceFacts {
  mac: string;
  ip: string;
  manufacturer: string;
  ipmi_mac: string;
  ipmi_ip: string;
  ipmi_tag: string;
  serial: string;
  board_serial: string;
  chassis_serial: string;
  system_uuid: string;
  platform: string;
  buildarch: string;
}

export type PendingDeviceRegistrar = (jobId: string, facts: PendingDeviceFacts) => Promise<boolean>;

export const IPXE_CHAIN_HIT_RECORDER = Symbol('IpxeChainHitRecorder');

export type ChainHitRecorder = (jobId: string, mac: string, deviceId: string | null) => Promise<void>;

const APP_CLASS_NAME = 'routes-chain';

@Controller()
export class IpxeController {
  constructor(
    private readonly chain: ChainService,
    @Optional()
    @Inject(IPXE_PENDING_DEVICE_REGISTRAR)
    private readonly registerPendingDevice?: PendingDeviceRegistrar,
    @Optional()
    @Inject(BULLMQ_RESULTS_SERVICE)
    private readonly results?: ResultsService,
    @Optional()
    @Inject(IPXE_CHAIN_HIT_RECORDER)
    private readonly recordChainHit?: ChainHitRecorder,
  ) {}

  @Post('api/chain')
  async chainEndpoint(@Body() body: unknown, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    // job_id reaches the unescaped iPXE template sink; CR/LF would inject script.
    const jobId = sanitizeChainJobId(extractJobIdFromRequest(req));
    void extractClientIpFromRequest(req.headers, req.ip ?? null);

    try {
      const parsed = ipxeChainBodySchema.safeParse(body ?? {});
      if (!parsed.success) {
        await logError(`Validation error: ${parsed.error.message}`, { jobId, appClassName: APP_CLASS_NAME });
        reply
          .status(HttpStatus.BAD_REQUEST)
          .header('content-type', 'text/plain')
          .send(`Error: ${parsed.error.message}`);
        return;
      }
      const params = parsed.data;

      let ipmiInfo = '';
      if (params.ipmi_ip || params.ipmi_mac || params.ipmi_tag) {
        ipmiInfo = `, IPMI IP: ${params.ipmi_ip}, IPMI MAC: ${params.ipmi_mac}, IPMI Tag: ${params.ipmi_tag}`;
      }

      let smbiosInfo = '';
      if (params.board_serial || params.chassis_serial || params.system_uuid) {
        smbiosInfo =
          `, Manufacturer: ${params.manufacturer}, Board Serial: ${params.board_serial},` +
          ` Chassis Serial: ${params.chassis_serial}, UUID: ${params.system_uuid}`;
      }

      await logInfo(
        `iPXE chain: MAC: ${params.mac}, Platform: ${params.platform}, Arch: ${params.buildarch}, Serial: ${params.serial}${ipmiInfo}${smbiosInfo}`,
        { jobId, appClassName: APP_CLASS_NAME },
      );

      const ipxeRequest: RenderRequest = {
        platform: params.platform,
        buildarch: params.buildarch,
        mac_address: params.mac,
        retry_count: params.retry_count,
      };
      this.chain.validateRequest(ipxeRequest);

      const identifiers = extractIdentifiers(params);
      // renderFacts feed the hub's placeholder atom; they never reach discovery:pending — the enrichment write below is what the commissioning grid reads.
      const renderFacts = { ip: params.ip, ipmi_ip: params.ipmi_ip, manufacturer: params.manufacturer };
      const record = await this.chain.resolveRecord(identifiers, params.buildarch, jobId, renderFacts);

      if (params.mac && this.recordChainHit) {
        try {
          await this.recordChainHit(jobId, params.mac, isResolveOutcome(record) ? null : record.id);
        } catch (error) {
          await logWarning(`ipxe:chain marker write failed for ${params.mac}: ${getErrorMessage(error)}`, {
            jobId,
            appClassName: APP_CLASS_NAME,
          });
        }
      }

      const hasIdentifier = Boolean(params.mac || params.system_uuid || params.serial);
      const notYetRealDevice =
        record === ResolveOutcome.UNKNOWN || (!isResolveOutcome(record) && isPlaceholder(record));
      let pendingRegistered = false;
      if (hasIdentifier && notYetRealDevice && this.registerPendingDevice) {
        try {
          pendingRegistered = await this.registerPendingDevice(jobId, {
            mac: params.mac,
            ip: params.ip,
            manufacturer: params.manufacturer,
            ipmi_mac: params.ipmi_mac,
            ipmi_ip: params.ipmi_ip,
            ipmi_tag: params.ipmi_tag,
            serial: params.serial,
            board_serial: params.board_serial,
            chassis_serial: params.chassis_serial,
            system_uuid: params.system_uuid,
            platform: params.platform,
            buildarch: params.buildarch,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const identity = params.mac || params.system_uuid || params.serial || '(none)';
          await logWarning(`discovery:pending write failed for ${identity}: ${message}`, {
            jobId,
            appClassName: APP_CLASS_NAME,
          });
        }
      }

      const ipxeScript = await this.chain.renderForRecord(record, ipxeRequest, jobId, pendingRegistered);
      reply.status(HttpStatus.OK).header('content-type', 'text/plain').send(ipxeScript);
    } catch (error) {
      if (error instanceof IpxeServiceError) {
        await logError(`iPXE service error: ${error.message}`, { jobId, appClassName: APP_CLASS_NAME });
        reply.status(HttpStatus.BAD_REQUEST).header('content-type', 'text/plain').send(`Error: ${error.message}`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await logError(`Unexpected error in iPXE chain: ${message}`, { jobId, appClassName: APP_CLASS_NAME });
      reply
        .status(HttpStatus.INTERNAL_SERVER_ERROR)
        .header('content-type', 'text/plain')
        .send('Error: Unable to generate iPXE script');
    }
  }

  @Get('api/chain-unreachable')
  async chainUnreachable(
    @Query() query: unknown,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const jobId = extractJobIdFromRequest(req);
    const parsed = chainUnreachableQuerySchema.safeParse(query ?? {});
    const mac = parsed.success ? parsed.data.mac : '';
    const attempts = parsed.success ? parsed.data.attempts : 0;
    await logWarning(`iPXE chainload unreachable: MAC ${mac || '(unknown)'} gave up after ${attempts} attempts`, {
      jobId,
      appClassName: APP_CLASS_NAME,
    });

    if (mac && this.results) {
      try {
        const record = await this.chain.resolveByPointerOnly({ mac }, jobId);
        if (!isResolveOutcome(record) && isProvisioningPhase(record.status) && record.last_job_id) {
          await this.results.enqueueResult({
            planId: record.last_job_id,
            stepName: 'ipxe_chainload',
            status: 'failed',
            deviceId: record.id,
            eventType: 'job_failed',
            actionType: 'provision',
            error: `iPXE chainload unreachable: gave up after ${attempts} attempts`,
            metadata: { source: 'ipxe_give_up_beacon', attempts },
          });
        }
      } catch (error) {
        await logWarning(`give-up beacon signal failed: ${getErrorMessage(error)}`, {
          jobId,
          appClassName: APP_CLASS_NAME,
        });
      }
    }

    reply.status(HttpStatus.OK).header('content-type', 'text/plain').send('ok');
  }
}
