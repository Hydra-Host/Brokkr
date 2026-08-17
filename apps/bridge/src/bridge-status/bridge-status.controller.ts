import { Controller, Get, HttpStatus, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { extractJobIdFromRequest } from '../common/middleware/job-id.middleware.js';
import { logError, logInfo } from '../logger/logger.service.js';

import { bridgeStatusResponseSchema } from './bridge-status.schema.js';
import { BridgeStatusServiceError, createBridgeStatusService } from './bridge-status.service.js';

const APP_CLASS_NAME = 'routes-status';

@Controller()
export class BridgeStatusController {
  @Get('api/status')
  async status(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const jobId = extractJobIdFromRequest(req);
    try {
      const service = await createBridgeStatusService(jobId);
      const currentBridgeUrl = `http://${req.headers.host ?? ''}`;
      const info = await service.getBridgeStatus(currentBridgeUrl);

      await logInfo('Bridge status retrieved successfully', { jobId, appClassName: APP_CLASS_NAME });
      const parsed = bridgeStatusResponseSchema.parse(info);
      reply.status(HttpStatus.OK).send(parsed);
    } catch (error) {
      if (error instanceof BridgeStatusServiceError) {
        await logError(`Bridge status service error: ${error.message}`, {
          jobId,
          appClassName: APP_CLASS_NAME,
        });
        reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await logError(`Unexpected error in bridge status: ${message}`, {
        jobId,
        appClassName: APP_CLASS_NAME,
      });
      reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send({ error: 'Internal server error' });
    }
  }
}
