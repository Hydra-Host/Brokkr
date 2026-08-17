import { Body, Controller, HttpStatus, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { JobIdService } from '../../common/job-id.service';
import { extractJobIdFromRequest } from '../../common/middleware/job-id.middleware';
import { logDebug, logError, logWarning } from '../../logger/logger.service';
import { getSnmpMonitoringConfig } from '../monitoring.config';
import {
  snmpGetRequestSchema,
  snmpResponseSchema,
  snmpWalkRequestSchema,
  type SnmpGetRequest,
  type SnmpWalkRequest,
} from '../monitoring.schema';

import { createSnmpMonitoringService, SnmpMonitoringError } from './snmp.service';

class SnmpTimeoutError extends Error {
  override name = 'SnmpTimeoutError';
}

async function withTimeout<T>(promise: Promise<T>, seconds: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(() => reject(new SnmpTimeoutError(`timeout after ${seconds}s`)), seconds * 1000);
    promise.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(handle);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function excludeNone(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val !== null && val !== undefined) out[key] = val;
  }
  return out;
}

const GET_SNMP_PARAM_KEYS = [
  'version',
  'community',
  'username',
  'security_level',
  'auth_protocol',
  'auth_passphrase',
  'priv_protocol',
  'priv_passphrase',
] as const;

const WALK_SNMP_PARAM_KEYS = GET_SNMP_PARAM_KEYS;

function pickSnmpParams<T extends Record<string, unknown>>(
  req: T,
  keys: ReadonlyArray<keyof T & string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = req[key];
  }
  return out;
}

@Controller()
export class MonitoringSnmpController {
  constructor(private readonly jobIdService: JobIdService) {}

  @Post('api/monitoring/snmp/get')
  async snmpGet(@Body() body: unknown, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const jobId = extractJobIdFromRequest(req);
    await this.jobIdService.run(jobId, () => this.handleGet(body, jobId, reply));
  }

  @Post('api/monitoring/snmp/walk')
  async snmpWalk(@Body() body: unknown, @Req() req: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const jobId = extractJobIdFromRequest(req);
    await this.jobIdService.run(jobId, () => this.handleWalk(body, jobId, reply));
  }

  private async handleGet(body: unknown, jobId: string, reply: FastifyReply): Promise<void> {
    const config = getSnmpMonitoringConfig();

    try {
      const parsed = snmpGetRequestSchema.safeParse(body ?? {});
      if (!parsed.success) {
        await logError(`Validation error: ${parsed.error.message}`, { jobId });
        await reply.status(HttpStatus.BAD_REQUEST).send({ error: parsed.error.message });
        return;
      }
      const data: SnmpGetRequest = parsed.data;

      await logDebug(
        `SNMP GET - target: ${data.target}:${data.port}, version: ${data.version}, OIDs: ${formatPyList(data.oids)}`,
        { jobId },
      );

      const service = createSnmpMonitoringService(jobId);
      const result = await withTimeout(
        service.executeSnmpGet(data.target, data.port, data.oids, pickSnmpParams(data, GET_SNMP_PARAM_KEYS)),
        config.requestTimeoutSeconds,
      );

      const respParsed = snmpResponseSchema.safeParse(result);
      if (!respParsed.success) {
        await logError(`Validation error: ${respParsed.error.message}`, { jobId });
        await reply.status(HttpStatus.BAD_REQUEST).send({ error: respParsed.error.message });
        return;
      }
      const resp = respParsed.data;
      const status = resp.result === 'success' || resp.result === 'partial' ? HttpStatus.OK : HttpStatus.BAD_REQUEST;
      await reply.status(status).send(excludeNone(resp as unknown as Record<string, unknown>));
    } catch (error) {
      if (error instanceof SnmpTimeoutError) {
        await logWarning(`SNMP GET timed out after ${config.requestTimeoutSeconds}s for ${jobId}`, { jobId });
        await reply
          .status(HttpStatus.REQUEST_TIMEOUT)
          .send({ error: `Request timed out after ${config.requestTimeoutSeconds} seconds` });
        return;
      }
      if (error instanceof SnmpMonitoringError) {
        await logError(`SNMP service error: ${error.message}`, { jobId });
        await reply.status(HttpStatus.BAD_REQUEST).send({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await logError(`Error processing SNMP GET request: ${message}`, { jobId });
      await reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send({ error: 'Internal server error' });
    }
  }

  private async handleWalk(body: unknown, jobId: string, reply: FastifyReply): Promise<void> {
    const config = getSnmpMonitoringConfig();

    try {
      const parsed = snmpWalkRequestSchema.safeParse(body ?? {});
      if (!parsed.success) {
        await logError(`Validation error: ${parsed.error.message}`, { jobId });
        await reply.status(HttpStatus.BAD_REQUEST).send({ error: parsed.error.message });
        return;
      }
      const data: SnmpWalkRequest = parsed.data;

      await logDebug(
        `SNMP WALK - target: ${data.target}:${data.port}, version: ${data.version}, OID: ${data.oid}, max: ${data.max_results}`,
        { jobId },
      );

      const service = createSnmpMonitoringService(jobId);
      const result = await withTimeout(
        service.executeSnmpWalk(
          data.target,
          data.port,
          data.oid,
          pickSnmpParams(data, WALK_SNMP_PARAM_KEYS),
          data.max_results,
        ),
        config.requestTimeoutSeconds,
      );

      const respParsed = snmpResponseSchema.safeParse(result);
      if (!respParsed.success) {
        await logError(`Validation error: ${respParsed.error.message}`, { jobId });
        await reply.status(HttpStatus.BAD_REQUEST).send({ error: respParsed.error.message });
        return;
      }
      const resp = respParsed.data;
      const status = resp.result === 'success' || resp.result === 'partial' ? HttpStatus.OK : HttpStatus.BAD_REQUEST;
      await reply.status(status).send(excludeNone(resp as unknown as Record<string, unknown>));
    } catch (error) {
      if (error instanceof SnmpTimeoutError) {
        await logWarning(`SNMP WALK timed out after ${config.requestTimeoutSeconds}s for ${jobId}`, { jobId });
        await reply
          .status(HttpStatus.REQUEST_TIMEOUT)
          .send({ error: `Request timed out after ${config.requestTimeoutSeconds} seconds` });
        return;
      }
      if (error instanceof SnmpMonitoringError) {
        await logError(`SNMP service error: ${error.message}`, { jobId });
        await reply.status(HttpStatus.BAD_REQUEST).send({ error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await logError(`Error processing SNMP WALK request: ${message}`, { jobId });
      await reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send({ error: 'Internal server error' });
    }
  }
}

function formatPyList(items: ReadonlyArray<string>): string {
  return `[${items.map((s) => `'${s}'`).join(', ')}]`;
}
