import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { FileServeService, FileServeServiceError } from '../common/file-serve.service.js';
import { JobIdService } from '../common/job-id.service.js';
import { sendFileAttachmentReply } from '../common/send-file.js';
import { logError, logInfo } from './download-logger.js';
import { grubDownloadParamsSchema } from './download.schema.js';
import { errorResponse } from './error-response.js';
import { extractJobIdFromRequest } from './extract-job-id.js';

const APP_CLASS_NAME = 'routes-grub';

@Controller()
export class GrubController {
  constructor(
    private readonly jobIdService: JobIdService,
    private readonly fileServeService: FileServeService,
  ) {}

  @Get('api/grub')
  async downloadFile(@Query() query: unknown, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const jobId = extractJobIdFromRequest(req);
    await this.jobIdService.run(jobId, async () => {
      const parsed = grubDownloadParamsSchema.safeParse(query ?? {});
      if (!parsed.success) {
        logError(`Validation error: ${parsed.error.message}`, { jobId, appClassName: APP_CLASS_NAME });
        await reply.status(400).send(errorResponse(parsed.error.message));
        return;
      }
      const params = parsed.data;

      try {
        logInfo(`GRUB download: ${params.arch}/${params.platform}`, { jobId, appClassName: APP_CLASS_NAME });

        const { filePath, filename, mimeType } = await this.fileServeService.serveGrubFile(
          params.arch,
          params.platform,
        );

        logInfo(`Sending GRUB file: ${filename}`, { jobId, appClassName: APP_CLASS_NAME });
        await sendFileAttachmentReply(reply, filePath, { filename, mimeType });
      } catch (e) {
        if (e instanceof FileServeServiceError) {
          logError(`File serve error: ${e.message}`, { jobId, appClassName: APP_CLASS_NAME });
          if (e.message.includes('Invalid architecture or platform')) {
            await reply.status(400).send(errorResponse(e.message));
          } else if (e.message.includes('not found')) {
            await reply.status(404).send(errorResponse(e.message));
          } else {
            await reply.status(500).send(errorResponse(e.message));
          }
          return;
        }
        logError(`Unexpected error serving GRUB file: ${e instanceof Error ? e.message : String(e)}`, {
          jobId,
          appClassName: APP_CLASS_NAME,
        });
        await reply.status(500).send(errorResponse('Internal server error'));
      }
    });
  }
}
