import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';

import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { JobIdService } from '../common/job-id.service.js';
import { inventoryDiscoveryImages, type FileStat } from '../startup/discovery-image-assert.js';
import { DiscoveryFileError, DiscoveryFileService } from './discovery-file.service.js';
import { discoveryInventoryResponseSchema } from './discovery-inventory.schema.js';
import { ARCH_SEGMENT_RE, getDiscoveryFileConfig } from './discovery.config.js';
import { logDebug, logError, logInfo } from './download-logger.js';
import { discoveryDownloadParamsSchema } from './download.schema.js';
import { errorResponse } from './error-response.js';
import { extractJobIdFromRequest } from './extract-job-id.js';

const APP_CLASS_NAME = 'routes-discovery';
const OCTET_STREAM = 'application/octet-stream';

interface ByteRange {
  startByte: number;
  endByte: number;
}

function parseIntStrict(token: string): number | null {
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;
  const n = Number.parseInt(trimmed, 10);
  if (Number.isNaN(n)) return null;
  return n;
}

function parseRangeHeader(rangeHeader: string, fileSize: number): ByteRange | null {
  if (!rangeHeader.startsWith('bytes=')) return null;
  const rangeSpec = rangeHeader.slice(6);
  const dashIndex = rangeSpec.indexOf('-');
  if (dashIndex < 0) return null;

  const startPart = rangeSpec.slice(0, dashIndex);
  const endPart = rangeSpec.slice(dashIndex + 1);

  let startByte: number | null = null;
  let endByte: number | null = null;

  if (startPart !== '') {
    startByte = parseIntStrict(startPart);
    if (startByte === null) return null;
  }
  if (endPart !== '') {
    endByte = parseIntStrict(endPart);
    if (endByte === null) return null;
  } else {
    endByte = fileSize - 1;
  }

  if (startByte === null) {
    if (endPart === '') return null;
    const suffixLength = parseIntStrict(endPart);
    if (suffixLength === null) return null;
    startByte = Math.max(0, fileSize - suffixLength);
    endByte = fileSize - 1;
  }

  startByte = Math.max(0, Math.min(startByte, fileSize - 1));
  endByte = Math.max(startByte, Math.min(endByte ?? fileSize - 1, fileSize - 1));

  return { startByte, endByte };
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

@Controller()
export class DiscoveryController {
  constructor(
    private readonly jobIdService: JobIdService,
    private readonly discoveryService: DiscoveryFileService,
  ) {}

  // TS-only (no Python parity equivalent). Returns RELATIVE arch/name only — never the absolute discoveryDir path (unauthenticated surface; see bridge-status.service.ts no-leak convention).
  @Get('api/discovery/inventory')
  async inventory(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const jobId = extractJobIdFromRequest(req);
    await this.jobIdService.run(jobId, async () => {
      try {
        const baseDir = this.discoveryService.discoveryDir;
        const statFile: FileStat = async (path) => {
          try {
            const s = await stat(path);
            return { present: s.isFile(), sizeBytes: s.size, mtimeMs: Math.trunc(s.mtimeMs) };
          } catch {
            return { present: false, sizeBytes: 0, mtimeMs: 0 };
          }
        };
        const architectures = await inventoryDiscoveryImages(
          { discoveryDir: baseDir, architectures: getDiscoveryFileConfig().architectures },
          statFile,
        );
        await reply.status(200).send(discoveryInventoryResponseSchema.parse({ architectures }));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        logError(`Error in inventory request: ${message}`, { jobId, appClassName: APP_CLASS_NAME });
        await reply.status(500).send(errorResponse(message));
      }
    });
  }

  @Get('api/discovery')
  async downloadFile(@Query() query: unknown, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const jobId = extractJobIdFromRequest(req);
    await this.jobIdService.run(jobId, async () => {
      const parsed = discoveryDownloadParamsSchema.safeParse(query ?? {});
      if (!parsed.success) {
        await reply.status(400).send(errorResponse(parsed.error.message));
        return;
      }

      await this.handleDiscoveryDownload(parsed.data.arch, parsed.data.filename, jobId, req, reply);
    });
  }

  @Get('api/discovery/:arch/:filename')
  async downloadFileByPath(
    @Param('arch') arch: string,
    @Param('filename') filename: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const jobId = extractJobIdFromRequest(req);
    await this.jobIdService.run(jobId, async () => {
      await this.handleDiscoveryDownload(arch, filename, jobId, req, reply);
    });
  }

  private async handleDiscoveryDownload(
    arch: string,
    filename: string,
    jobId: string,
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      // arch list must come from the same env source as the sync side, else a freshly-synced arch would 400
      const fileConfig = getDiscoveryFileConfig();
      const supportedArches = fileConfig.architectures;
      if (!ARCH_SEGMENT_RE.test(arch) || !supportedArches.includes(arch)) {
        await reply.status(400).send(errorResponse(`Invalid architecture. Supported: ${supportedArches.join(', ')}`));
        return;
      }

      const safeFilename = basename(filename);
      const filePath = join(this.discoveryService.discoveryDir, arch, safeFilename);

      const exists = await stat(filePath).then(
        () => true,
        () => false,
      );
      if (!exists) {
        await reply.status(404).send(errorResponse('File not found'));
        return;
      }

      const fileSize = await this.discoveryService.getFileSize(filePath);
      if (fileSize === null) {
        await reply.status(500).send(errorResponse('Unable to determine file size'));
        return;
      }

      const rangeHeader = firstHeaderValue(req.headers['range']);
      let range: ByteRange | null = null;
      if (rangeHeader !== null) {
        range = parseRangeHeader(rangeHeader, fileSize);
        if (range === null && rangeHeader.startsWith('bytes=') && rangeHeader.slice(6).includes('-')) {
          logDebug(`Invalid Range header format: ${rangeHeader}`, { jobId, appClassName: APP_CLASS_NAME });
        }
      }

      logInfo(`Serving discovery file: ${arch}/${safeFilename} (${fileSize} bytes)`, {
        jobId,
        appClassName: APP_CLASS_NAME,
      });

      const source =
        range !== null
          ? Readable.from(
              this.discoveryService.streamFile(filePath, {
                fileSize,
                startByte: range.startByte,
                endByte: range.endByte,
              }),
            )
          : Readable.from(this.discoveryService.streamFile(filePath, { fileSize }));

      const timeoutSeconds = fileConfig.discoveryDownloadTimeout;
      if (timeoutSeconds > 0) {
        const budgetMs = timeoutSeconds * 1000;
        const socket = reply.raw?.socket ?? null;
        let cancel: () => void = () => {};
        if (socket !== null) {
          let lastWritten = socket.bytesWritten;
          let lastProgressAt = Date.now();
          const interval = setInterval(
            () => {
              if (socket.bytesWritten !== lastWritten) {
                lastWritten = socket.bytesWritten;
                lastProgressAt = Date.now();
              } else if (Date.now() - lastProgressAt >= budgetMs) {
                clearInterval(interval);
                source.destroy(new Error(`Idle timeout: no send progress for ${timeoutSeconds}s`));
              }
            },
            Math.max(1000, Math.min(budgetMs, 5000)),
          );
          interval.unref?.();
          cancel = (): void => clearInterval(interval);
        } else {
          const timer = setTimeout(
            () => source.destroy(new Error(`Absolute timeout: download exceeded ${timeoutSeconds}s`)),
            budgetMs,
          );
          timer.unref?.();
          cancel = (): void => clearTimeout(timer);
        }
        source.once('end', cancel);
        source.once('close', cancel);
        source.once('error', cancel);
      }

      if (range !== null) {
        const rangeSize = range.endByte - range.startByte + 1;
        await reply
          .status(206)
          .header('content-type', OCTET_STREAM)
          .header('content-range', `bytes ${range.startByte}-${range.endByte}/${fileSize}`)
          .header('content-length', String(rangeSize))
          .header('content-disposition', `attachment; filename=${safeFilename}`)
          .send(source);
        return;
      }

      await reply
        .status(200)
        .header('content-type', OCTET_STREAM)
        .header('content-length', String(fileSize))
        .header('accept-ranges', 'bytes')
        .header('content-disposition', `attachment; filename=${safeFilename}`)
        .send(source);
    } catch (e) {
      if (e instanceof DiscoveryFileError) {
        logError(`Discovery file error: ${e.message}`, { jobId, appClassName: APP_CLASS_NAME });
        await reply.status(500).send(errorResponse(e.message));
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      logError(`Error in download request: ${message}`, { jobId, appClassName: APP_CLASS_NAME });
      await reply.status(500).send(errorResponse(message));
    }
  }
}
