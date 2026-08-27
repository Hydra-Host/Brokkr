import { Inject, Injectable, Logger } from '@nestjs/common';
import { Agent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';

import type { NomadConfig } from '../schemas';
import { NOMAD_CONFIG_TOKEN } from './config.token';
import { NomadHttpError } from './nomad.errors';
import {
  type DeregisterJobParams,
  type DispatchJobParams,
  type GetAllocLogsParams,
  type GetEvaluationParams,
  type GetJobAllocationsParams,
  type GetJobParams,
  type GetNodeParams,
  NomadDeregisterJobResponseSchema,
  NomadDispatchJobResponseSchema,
  NomadEvaluationStatusSchema,
  NomadJobAllocationsResponseSchema,
  NomadJobDetailSchema,
  NomadJobSummarySchema,
  NomadNodeDetailSchema,
  NomadNodesResponseSchema,
  NomadParsedJobSchema,
  NomadPlanJobResponseSchema,
  NomadSubmitJobResponseSchema,
  NomadValidateJobResponseSchema,
  type ParseJobParams,
  type PlanJobParams,
  type SubmitParsedJobParams,
  type ValidateJobParams,
} from './types/nomad-api';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** Default log tail size in bytes for single-shot alloc log reads. */
export const DEFAULT_LOG_OFFSET_BYTES = 16_384;

/** Config-driven Nomad HTTP client (no Vault/Prisma). Adapted from prior Brokkr hub Nomad client. */
@Injectable()
export class NomadClient {
  private readonly logger = new Logger(NomadClient.name);
  private readonly dispatcher: Agent | undefined;

  constructor(@Inject(NOMAD_CONFIG_TOKEN) private readonly config: NomadConfig) {
    this.dispatcher = config.tlsSkipVerify ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;
    if (config.tlsSkipVerify) {
      this.logger.warn(
        'NOMAD_SKIP_VERIFY is enabled — TLS certificate verification is disabled and the Nomad ACL token is exposed to any on-path attacker. Do not use outside a lab.',
      );
    }
  }

  /** Default Nomad namespace from plugin config (request overrides still win at the call site). */
  get defaultNamespace(): string {
    return this.config.namespace;
  }

  async parseJob({ jobHCL, namespace = this.config.namespace, canonicalize = true, variables = '' }: ParseJobParams) {
    return this.request({
      method: 'POST',
      path: `/v1/jobs/parse?namespace=${encodeURIComponent(namespace)}`,
      body: {
        JobHCL: jobHCL,
        Canonicalize: canonicalize,
        Variables: variables,
      },
      schema: NomadParsedJobSchema,
    });
  }

  async validateJob({ job, namespace = this.config.namespace }: ValidateJobParams) {
    return this.request({
      method: 'POST',
      path: `/v1/validate/job?namespace=${encodeURIComponent(namespace)}`,
      body: { Job: job },
      schema: NomadValidateJobResponseSchema,
    });
  }

  async planJob({ jobId, job, namespace = this.config.namespace, diff = true }: PlanJobParams) {
    return this.request({
      method: 'POST',
      path: `/v1/job/${encodeURIComponent(jobId)}/plan?namespace=${encodeURIComponent(namespace)}`,
      body: { Job: job, Diff: diff },
      schema: NomadPlanJobResponseSchema,
    });
  }

  async submitParsedJob({ job, namespace = this.config.namespace }: SubmitParsedJobParams) {
    return this.request({
      method: 'POST',
      path: `/v1/jobs?namespace=${encodeURIComponent(namespace)}`,
      body: { Job: job },
      schema: NomadSubmitJobResponseSchema,
    });
  }

  async getEvaluation({ evalId, namespace = this.config.namespace }: GetEvaluationParams) {
    return this.request({
      method: 'GET',
      path: `/v1/evaluation/${encodeURIComponent(evalId)}?namespace=${encodeURIComponent(namespace)}`,
      schema: NomadEvaluationStatusSchema,
    });
  }

  async getJobAllocations({ jobId, namespace = this.config.namespace }: GetJobAllocationsParams) {
    return this.request({
      method: 'GET',
      path: `/v1/job/${encodeURIComponent(jobId)}/allocations?namespace=${encodeURIComponent(namespace)}`,
      schema: NomadJobAllocationsResponseSchema,
    });
  }

  async getJob({ jobId, namespace = this.config.namespace }: GetJobParams) {
    return this.request({
      method: 'GET',
      path: `/v1/job/${encodeURIComponent(jobId)}?namespace=${encodeURIComponent(namespace)}`,
      schema: NomadJobSummarySchema,
    });
  }

  /** Full job read (task Config/Resources/Env) for deploy prefill; getJob stays a status summary. */
  async readJob({ jobId, namespace = this.config.namespace }: GetJobParams) {
    return this.request({
      method: 'GET',
      path: `/v1/job/${encodeURIComponent(jobId)}?namespace=${encodeURIComponent(namespace)}`,
      schema: NomadJobDetailSchema,
    });
  }

  /** Stop/deregister a job. purge=true removes it from GC history. */
  async deregisterJob({ jobId, namespace = this.config.namespace, purge = false }: DeregisterJobParams) {
    const params = new URLSearchParams({
      namespace,
      purge: purge ? 'true' : 'false',
    });
    return this.request({
      method: 'DELETE',
      path: `/v1/job/${encodeURIComponent(jobId)}?${params.toString()}`,
      schema: NomadDeregisterJobResponseSchema,
    });
  }

  /** Dispatch a parameterized job; payload is base64-encoded for Nomad's Payload field. */
  async dispatchJob({ jobId, meta, payload, namespace = this.config.namespace }: DispatchJobParams) {
    return this.request({
      method: 'POST',
      path: `/v1/job/${encodeURIComponent(jobId)}/dispatch?namespace=${encodeURIComponent(namespace)}`,
      body: {
        Meta: meta ?? {},
        Payload: payload === undefined ? undefined : Buffer.from(payload, 'utf8').toString('base64'),
      },
      schema: NomadDispatchJobResponseSchema,
    });
  }

  /** Node APIs are cluster-level (not namespaced), so no namespace query param. */
  async listNodes() {
    return this.request({
      method: 'GET',
      path: '/v1/nodes',
      schema: NomadNodesResponseSchema,
    });
  }

  async getNode({ nodeId }: GetNodeParams) {
    return this.request({
      method: 'GET',
      path: `/v1/node/${encodeURIComponent(nodeId)}`,
      schema: NomadNodeDetailSchema,
    });
  }

  /** Bounded single-shot log read (plain=true, follow=false) — returns raw text, never a stream. */
  async getAllocLogs({
    allocId,
    task,
    type,
    origin = 'end',
    offset = DEFAULT_LOG_OFFSET_BYTES,
    namespace = this.config.namespace,
  }: GetAllocLogsParams): Promise<string> {
    const params = new URLSearchParams({
      namespace,
      task,
      type,
      origin,
      offset: String(offset),
      plain: 'true',
      follow: 'false',
    });
    return this.fetchText({
      method: 'GET',
      path: `/v1/client/fs/logs/${encodeURIComponent(allocId)}?${params.toString()}`,
    });
  }

  private async request<TSchema extends z.ZodTypeAny>(args: {
    method: HttpMethod;
    path: string;
    body?: unknown;
    schema: TSchema;
  }): Promise<z.infer<TSchema>> {
    const text = await this.fetchText(args);
    let parsedBody: unknown = null;
    if (text.length > 0) {
      try {
        parsedBody = JSON.parse(text) as unknown;
      } catch {
        parsedBody = text;
      }
    }
    return args.schema.parse(parsedBody);
  }

  /** Shared fetch + error mapping; returns the raw response body (JSON left unparsed). */
  private async fetchText(args: { method: HttpMethod; path: string; body?: unknown }): Promise<string> {
    const url = `${this.config.address.replace(/\/$/, '')}${args.path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Nomad-Token': this.config.token,
    };
    if (this.config.region) {
      headers['X-Nomad-Region'] = this.config.region;
    }

    let response: Response;
    try {
      response = await this.doFetch(url, {
        method: args.method,
        headers,
        body: args.body === undefined ? undefined : JSON.stringify(args.body),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      if (err instanceof NomadHttpError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new NomadHttpError({
        method: args.method,
        path: args.path,
        status: 0,
        body: message,
        message: `Nomad ${args.method} ${args.path} network error: ${message}`,
      });
    }

    const text = await response.text();
    if (!response.ok) {
      let parsedBody: unknown = text.length > 0 ? text : null;
      if (text.length > 0) {
        try {
          parsedBody = JSON.parse(text) as unknown;
        } catch {
          parsedBody = text;
        }
      }
      throw new NomadHttpError({
        method: args.method,
        path: args.path,
        status: response.status,
        body: parsedBody,
      });
    }

    return text;
  }

  /** Global fetch unless tlsSkipVerify needs an undici Agent. */
  private async doFetch(url: string, init: RequestInit): Promise<Response> {
    if (this.dispatcher) {
      return undiciFetch(url, {
        method: init.method,
        headers: init.headers as Record<string, string>,
        body: init.body as string | undefined,
        signal: init.signal ?? undefined,
        dispatcher: this.dispatcher,
      }) as unknown as Response;
    }
    return fetch(url, init);
  }
}
