import { realpath, stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';

import { Controller, Get, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { JobIdService } from '../common/job-id.service.js';
import { sendFileAttachmentReply } from '../common/send-file.js';
import { logError, logInfo, logWarning } from './download-logger.js';
import { errorResponse } from './error-response.js';
import { extractJobIdFromRequest } from './extract-job-id.js';
import { getStorageConfig, type StorageConfig } from './storage.config.js';

const APP_CLASS_NAME = 'routes-os-image';
const OCTET_STREAM = 'application/octet-stream';
const ALLOWED_SUFFIXES = ['.tar.gz', '.tar.zst'];

function readWildcardParam(params: unknown): string {
  if (typeof params === 'object' && params !== null) {
    const value: unknown = Reflect.get(params, '*');
    if (typeof value === 'string') return value;
  }
  return '';
}

function decodeFilename(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// Deliberately throws when `httpsOsImagesDir` is absent (route broken pending upstream config fix); do NOT add the field to StorageConfig to "fix" the 500.
function readHttpsOsImagesDir(): string {
  const cfg = getStorageConfig() as StorageConfig & { httpsOsImagesDir?: unknown };
  const value = cfg.httpsOsImagesDir;
  if (typeof value !== 'string') {
    throw new Error("StorageConfig is missing required property 'httpsOsImagesDir'");
  }
  return value;
}

async function resolveOsImage(filename: string): Promise<string | null> {
  const configuredDir = readHttpsOsImagesDir();
  const cacheDir = await realpath(resolve(configuredDir)).catch(() => resolve(configuredDir));

  const lexicalCandidate = resolve(cacheDir, filename);
  if (lexicalCandidate !== cacheDir && !lexicalCandidate.startsWith(`${cacheDir}${sep}`)) {
    return null;
  }
  let candidate: string;
  try {
    candidate = await realpath(lexicalCandidate);
  } catch {
    return null;
  }
  if (candidate !== cacheDir && !candidate.startsWith(`${cacheDir}${sep}`)) {
    return null;
  }
  if (!ALLOWED_SUFFIXES.some((s) => basename(candidate).endsWith(s))) {
    return null;
  }
  const isFile = await stat(candidate).then(
    (st) => st.isFile(),
    () => false,
  );
  if (!isFile) {
    return null;
  }
  return candidate;
}

@Controller()
export class OsImageController {
  constructor(private readonly jobIdService: JobIdService) {}

  @Get('api/os-image/*')
  async downloadOsImage(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const jobId = extractJobIdFromRequest(req);
    await this.jobIdService.run(jobId, async () => {
      const filename = decodeFilename(readWildcardParam(req.params));

      try {
        const resolved = await resolveOsImage(filename);
        if (resolved === null) {
          logWarning(`OS image request rejected: ${JSON.stringify(filename)}`, { jobId, appClassName: APP_CLASS_NAME });
          await reply.status(404).send(errorResponse(`OS image '${filename}' not found`));
          return;
        }

        try {
          logInfo(`Sending OS image: ${basename(resolved)}`, { jobId, appClassName: APP_CLASS_NAME });
          await sendFileAttachmentReply(reply, resolved, { filename: basename(resolved), mimeType: OCTET_STREAM });
        } catch (e) {
          logError(
            `Error serving OS image ${JSON.stringify(filename)}: ${e instanceof Error ? e.message : String(e)}`,
            {
              jobId,
              appClassName: APP_CLASS_NAME,
            },
          );
          await reply.status(500).send(errorResponse('Internal server error'));
        }
      } catch (e) {
        logError(`OS image route failed: ${e instanceof Error ? e.message : String(e)}`, {
          jobId,
          appClassName: APP_CLASS_NAME,
        });
        throw e;
      }
    });
  }
}
