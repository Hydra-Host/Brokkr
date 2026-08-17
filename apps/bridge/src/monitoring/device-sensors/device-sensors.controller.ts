import { Controller, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { isRecord } from '@repo/utils';

import { bmcCredentials } from '../../common/bmc.types';
import { errorResponse } from '../../download/error-response';
import { extractJobIdFromRequest } from '../../download/extract-job-id';
import { logError, logInfo } from '../../logger/logger.service';
import { getDeviceCredentialResolver, resolveMetricsTarget } from '../common/device-credential-resolver.service';
import { deviceSensorsRequestSchema } from '../monitoring.schema';
import { DeviceSensorsService } from './device-sensors.service';

const APP_CLASS_NAME = 'routes-device-sensors';

@Controller()
export class DeviceSensorsController {
  constructor(private readonly deviceSensors: DeviceSensorsService) {}

  @Post('api/monitoring/device/sensors')
  async collect(@Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const jobId = extractJobIdFromRequest(req);

    try {
      const rawBody = req.body as unknown;
      const body = isRecord(rawBody) ? rawBody : {};
      const parsed = deviceSensorsRequestSchema.safeParse(body);
      if (!parsed.success) {
        await logError(`Validation error: ${parsed.error.message}`, { jobId, appClassName: APP_CLASS_NAME });
        await reply.status(400).send(errorResponse(parsed.error.message));
        return;
      }
      const request = parsed.data;

      const resolved = await resolveMetricsTarget({
        deviceId: request.device_id,
        ip: null,
        username: null,
        password: null,
      });
      const bmcIp = resolved.ip;
      const username = resolved.username;
      const password = resolved.password;
      const usedResolver = resolved.usedResolver;

      if (!(bmcIp && username && password)) {
        await reply
          .status(400)
          .send(errorResponse(`could not resolve BMC credentials for device_id ${request.device_id}`));
        return;
      }

      let doc = await this.deviceSensors.collect(
        request.device_id,
        bmcCredentials(bmcIp, username, password),
        request.kind,
      );

      if (this.deviceSensors.authRejected && usedResolver && request.device_id) {
        const resolver = getDeviceCredentialResolver();
        resolver.invalidate(request.device_id);
        const creds = await resolver.resolve(request.device_id);
        if (creds !== null && (creds.bmcIp !== bmcIp || creds.username !== username || creds.password !== password)) {
          await logInfo(
            `Device sensors auth rejected; re-resolved creds for device_id ${request.device_id}, retrying`,
            { jobId, appClassName: APP_CLASS_NAME },
          );
          doc = await this.deviceSensors.collect(request.device_id, creds, request.kind);
        }
      }

      let total = 0;
      for (const points of Object.values(doc)) {
        total += points.length;
      }
      await logInfo(
        `Device sensors collected - device_id: ${request.device_id}, kind: ${request.kind}, points: ${total}`,
        { jobId, appClassName: APP_CLASS_NAME },
      );
      await reply.status(200).send(doc);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logError(`Error collecting device sensors: ${message}`, { jobId, appClassName: APP_CLASS_NAME });
      await reply.status(500).send(errorResponse('Internal server error'));
    }
  }
}
