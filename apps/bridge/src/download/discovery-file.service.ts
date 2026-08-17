import { open, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { Injectable } from '@nestjs/common';

import { JobIdService } from '../common/job-id.service.js';
import { getDiscoveryFileConfig } from './discovery.config.js';
import { logDebug, logError, logInfo } from './download-logger.js';
import { getStorageConfig } from './storage.config.js';

const APP_CLASS_NAME = 'service-discovery-file';

export class DiscoveryFileError extends Error {}

function isOsErrorLike(exc: unknown): boolean {
  if (typeof exc !== 'object' || exc === null) return false;
  const obj = exc as { code?: unknown; errno?: unknown };
  return typeof obj.code === 'string' || typeof obj.errno === 'number';
}

export interface StreamFileOptions {
  fileSize?: number | null;
  chunkSize?: number | null;
  startByte?: number | null;
  endByte?: number | null;
}

@Injectable()
export class DiscoveryFileService {
  constructor(private readonly jobIdService: JobIdService) {}

  get discoveryDir(): string {
    return getStorageConfig().brokkrLiveHttpsDir;
  }

  async getFileSize(filePath: string): Promise<number | null> {
    const jobId = this.jobIdService.current();
    try {
      logDebug(`Getting file size for: ${filePath}`, { appClassName: APP_CLASS_NAME, jobId });
      const fileStat = await stat(filePath);
      const size = fileStat.size;
      logDebug(`File stat retrieved, size: ${size} bytes`, { appClassName: APP_CLASS_NAME, jobId });
      logInfo(`File size for ${basename(filePath)}: ${size} bytes`, { appClassName: APP_CLASS_NAME, jobId });
      return size;
    } catch (exc) {
      if (!isOsErrorLike(exc)) throw exc;
      logError(`Error getting file size for ${filePath}: ${exc instanceof Error ? exc.message : String(exc)}`, {
        appClassName: APP_CLASS_NAME,
        jobId,
      });
      return null;
    }
  }

  async *streamFile(filePath: string, options: StreamFileOptions = {}): AsyncGenerator<Buffer, void, undefined> {
    const jobId = this.jobIdService.current();
    try {
      logDebug(`Starting file streaming for: ${filePath}`, { appClassName: APP_CLASS_NAME, jobId });

      let chunkSize = options.chunkSize ?? null;
      if (chunkSize === null) {
        chunkSize = getDiscoveryFileConfig().chunkSize;
        logDebug(`Using configured chunk size: ${chunkSize} bytes`, { appClassName: APP_CLASS_NAME, jobId });
      }

      let fileSize = options.fileSize ?? null;
      if (fileSize === null) {
        logDebug('File size not provided, determining from file system', { appClassName: APP_CLASS_NAME, jobId });
        fileSize = await this.getFileSize(filePath);
        if (fileSize === null) {
          throw new DiscoveryFileError('Unable to determine file size');
        }
      }

      let startByte = options.startByte ?? 0;
      let endByte = options.endByte ?? fileSize - 1;

      startByte = Math.max(0, Math.min(startByte, fileSize - 1));
      endByte = Math.max(startByte, Math.min(endByte, fileSize - 1));

      const rangeSize = endByte - startByte + 1;

      logInfo(
        `Starting file stream: ${basename(filePath)} (range: ${startByte}-${endByte}, ${rangeSize} bytes, ${chunkSize} byte chunks)`,
        { appClassName: APP_CLASS_NAME, jobId },
      );

      let bytesSent = 0;
      const handle = await open(filePath, 'r');
      try {
        if (startByte > 0) {
          logDebug(`Reading from byte position: ${startByte}`, { appClassName: APP_CLASS_NAME, jobId });
        }
        let position = startByte;
        while (bytesSent < rangeSize) {
          const toRead = Math.min(chunkSize, rangeSize - bytesSent);
          const buffer = Buffer.alloc(toRead);
          const { bytesRead } = await handle.read(buffer, 0, toRead, position);
          if (bytesRead === 0) break;
          position += bytesRead;
          bytesSent += bytesRead;
          yield bytesRead === toRead ? buffer : buffer.subarray(0, bytesRead);
        }
      } finally {
        await handle.close();
      }

      logInfo(
        `File stream completed: ${basename(filePath)} (range: ${startByte}-${endByte}, ${bytesSent} bytes sent)`,
        {
          appClassName: APP_CLASS_NAME,
          jobId,
        },
      );
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      logError(`Error streaming file ${filePath}: ${message}`, { appClassName: APP_CLASS_NAME, jobId });
      throw new DiscoveryFileError(`Failed to stream file: ${message}`);
    }
  }
}
