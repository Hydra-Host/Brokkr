import { stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { Injectable } from '@nestjs/common';

import { resolveAssetsDir } from '../core/application.config.js';
import { logDebug, logError, logInfo } from '../core/logging/bridge-logger.js';
import { JobIdService } from './job-id.service.js';

const APP_CLASS_NAME = 'service-file-serve';

const ALLOWED_GRUB_FILES: ReadonlyMap<string, string> = new Map([
  ['amd64:efi', 'bootx64.efi'],
  ['amd64:pcbios', 'core.img'],
  ['arm64:efi', 'bootaa64.efi'],
]);

const MIME_TYPES: ReadonlyMap<string, string> = new Map([
  ['.txt', 'text/plain'],
  ['.json', 'application/json'],
  ['.html', 'text/html'],
  ['.iso', 'application/x-iso9660-image'],
  ['.efi', 'application/efi'],
]);

export class FileServeServiceError extends Error {}

export function guessMimeType(filePath: string): string {
  return MIME_TYPES.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream';
}

export interface ServedGrubFile {
  filePath: string;
  filename: string;
  mimeType: string;
}

@Injectable()
export class FileServeService {
  constructor(private readonly jobIdService: JobIdService) {}

  async serveGrubFile(arch: string, platform: string): Promise<ServedGrubFile> {
    const jobId = this.jobIdService.current();
    try {
      logDebug(`Starting GRUB file serving for arch=${arch}, platform=${platform}`, {
        appClassName: APP_CLASS_NAME,
        jobId,
      });
      logInfo(`Serving GRUB file for arch=${arch}, platform=${platform}`, { appClassName: APP_CLASS_NAME, jobId });

      const safeFilename = ALLOWED_GRUB_FILES.get(`${arch}:${platform}`);
      if (!safeFilename) {
        const errorMsg = `Invalid architecture or platform: arch=${arch}, platform=${platform}`;
        logError(errorMsg, { appClassName: APP_CLASS_NAME, jobId });
        throw new FileServeServiceError(errorMsg);
      }

      logDebug(`Mapping ${arch}/${platform} to filename: ${safeFilename}`, { appClassName: APP_CLASS_NAME, jobId });
      const filePath = join(resolveAssetsDir(), 'download', 'grub', safeFilename);
      logDebug(`Constructed file path: ${filePath}`, { appClassName: APP_CLASS_NAME, jobId });

      const exists = await stat(filePath).then(
        (s) => s.isFile(),
        () => false,
      );
      if (!exists) {
        const errorMsg = `GRUB file not found: ${safeFilename}`;
        logError(errorMsg, { appClassName: APP_CLASS_NAME, jobId });
        throw new FileServeServiceError(errorMsg);
      }

      const mimeType = guessMimeType(filePath);

      logInfo(`Serving GRUB file: ${filePath}`, { appClassName: APP_CLASS_NAME, jobId });
      return { filePath, filename: safeFilename, mimeType };
    } catch (exc) {
      if (exc instanceof FileServeServiceError) throw exc;
      const errorMsg = `Error serving GRUB file: ${exc instanceof Error ? exc.message : String(exc)}`;
      logError(errorMsg, { appClassName: APP_CLASS_NAME, jobId });
      throw new FileServeServiceError(errorMsg);
    }
  }
}
