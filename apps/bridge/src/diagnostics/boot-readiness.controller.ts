import { Controller, Get, HttpStatus, Inject, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { getErrorMessage } from '../common/error-utils.js';
import { extractJobIdFromRequest } from '../common/middleware/job-id.middleware.js';
import { logError } from '../logger/logger.service.js';

import {
  BOOT_READINESS_CHECKS,
  bootReadinessResponseSchema,
  evaluateBootReadiness,
  type BootReadinessCheckFactory,
} from './boot-readiness.js';

const APP_CLASS_NAME = 'routes-boot-readiness';

@Controller()
export class BootReadinessController {
  constructor(@Inject(BOOT_READINESS_CHECKS) private readonly checksFor: BootReadinessCheckFactory) {}

  @Get('api/boot-readiness')
  async bootReadiness(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const jobId = extractJobIdFromRequest(req);
    try {
      const report = await evaluateBootReadiness(this.checksFor(jobId));
      reply.status(HttpStatus.OK).send(bootReadinessResponseSchema.parse(report));
    } catch (error) {
      await logError(`Boot readiness evaluation failed: ${getErrorMessage(error)}`, {
        jobId,
        appClassName: APP_CLASS_NAME,
      });
      reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send({ error: 'Internal server error' });
    }
  }
}
