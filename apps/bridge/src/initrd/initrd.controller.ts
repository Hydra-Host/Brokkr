import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';

import { getErrorMessage } from '../common/error-utils.js';
import { extractClientIpFromRequest } from '../common/job-id.service.js';
import { sendFileAttachment } from '../common/send-file.js';
import { getJobId } from '../logger/context/job-id.context.js';
import { logError } from '../logger/logger.service.js';

import { initrdDownloadParamsSchema } from './download.schema.js';
import { InitrdOrchestrationService } from './initrd-orchestration.service.js';

const OCTET_STREAM = 'application/octet-stream';
const INVALID_BUILD_TYPE_MESSAGE =
  'Invalid build type. Supported: brokkr-live.img, bridge-agent.img, ' +
  'brokkr-discovery-{id}.img, brokkr-discovery-mac-{mac}.img, ' +
  'ubuntu-rescue-os-{id}.img';

interface InitrdReply {
  status(code: number): InitrdReply;
  send(payload: unknown): unknown;
  raw?: NodeServerResponse;
  setHeader?(name: string, value: string): unknown;
  on?(event: 'close', listener: () => void): unknown;
  write?(chunk: Buffer | string): unknown;
  end?(cb?: () => void): unknown;
}

interface NodeServerResponse {
  statusCode: number;
  setHeader(name: string, value: string | number | string[]): unknown;
  on(event: 'close', listener: () => void): unknown;
  write(chunk: Buffer | string): unknown;
  end(cb?: () => void): unknown;
}

interface InitrdRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
}

function fileStreamSink(reply: InitrdReply): {
  status(code: number): { send(payload: unknown): unknown };
  setHeader(name: string, value: string): unknown;
  on(event: 'close', listener: () => void): unknown;
  write(chunk: Buffer | string): unknown;
  end(cb?: () => void): unknown;
} {
  const raw = reply.raw;
  if (raw !== undefined) {
    return {
      status(code: number) {
        raw.statusCode = code;
        return { send: (_payload: unknown) => raw.end() };
      },
      setHeader: (name, value) => raw.setHeader(name, value),
      on: (event, listener) => raw.on(event, listener),
      write: (chunk) => raw.write(chunk),
      // fastify-inject treats end()'s first arg as body data, so invoke cb after a synchronous end()
      end: (cb) => {
        raw.end();
        if (cb !== undefined) cb();
      },
    };
  }
  return reply as unknown as {
    status(code: number): { send(payload: unknown): unknown };
    setHeader(name: string, value: string): unknown;
    on(event: 'close', listener: () => void): unknown;
    write(chunk: Buffer | string): unknown;
    end(cb?: () => void): unknown;
  };
}

@Controller()
export class InitrdController {
  constructor(private readonly orchestration: InitrdOrchestrationService) {}

  @Get('api/initrd')
  async downloadInitrd(@Query() query: unknown, @Res() reply: InitrdReply): Promise<void> {
    try {
      const parsed = initrdDownloadParamsSchema.parse(query ?? {});
      const buildName = parsed.build ?? null;
      const resolved = await this.orchestration.resolveDefaultDownload(getJobId(), buildName);
      if (resolved.initrdFile === null) {
        await reply.status(404).send({ error: `Initrd build '${buildName || 'brokkr-live'}' not found` });
        return;
      }
      await sendFileAttachment(fileStreamSink(reply), resolved.initrdFile, {
        filename: `initrd-brokkr-${buildName || 'brokkr-live'}.img`,
        mimeType: OCTET_STREAM,
      });
    } catch (error) {
      void logError(`initrd download failed: ${getErrorMessage(error)}`, {
        jobId: getJobId(),
        appClassName: 'initrd-controller',
      });
      await reply.status(500).send({ error: 'Internal server error' });
    }
  }

  @Get('api/initrd/:buildName')
  async downloadInitrdByPath(
    @Param('buildName') buildName: string,
    @Req() req: InitrdRequest,
    @Res() reply: InitrdReply,
  ): Promise<void> {
    try {
      const clientIp = extractClientIpFromRequest(req.headers, req.ip ?? null);
      const resolved = await this.orchestration.resolveDownloadByPath(getJobId(), buildName, clientIp);
      if (resolved.invalidBuildName) {
        await reply.status(400).send({ error: INVALID_BUILD_TYPE_MESSAGE });
        return;
      }
      if (resolved.initrdFile === null) {
        await reply.status(404).send({ error: `Initrd build '${buildName}' not found` });
        return;
      }
      await sendFileAttachment(fileStreamSink(reply), resolved.initrdFile, {
        filename: `initrd-brokkr-${buildName}.img`,
        mimeType: OCTET_STREAM,
        // Per-device discovery/rescue images embed live secrets — never cache.
        noStore: resolved.secretBearing,
      });
    } catch (error) {
      void logError(`initrd download failed: ${getErrorMessage(error)} (buildName=${buildName})`, {
        jobId: getJobId(),
        appClassName: 'initrd-controller',
      });
      await reply.status(500).send({ error: 'Internal server error' });
    }
  }
}
