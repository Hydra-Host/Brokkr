import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type {
  NomadAllocsQuery,
  NomadAllocsResult,
  NomadAllocSummary,
  NomadDispatchRequest,
  NomadDispatchResult,
  NomadJobQuery,
  NomadJobReadResult,
  NomadJobRequest,
  NomadJobTask,
  NomadJobTaskGroup,
  NomadLogsQuery,
  NomadLogsResult,
  NomadNode,
  NomadNodesQuery,
  NomadNodesResult,
  NomadPlanResult,
  NomadStartupStatus,
  NomadStatusQuery,
  NomadStopRequest,
  NomadStopResult,
  NomadSubmitResult,
  NomadValidateResult,
  NomadVariables,
} from '../schemas';
import { BRIDGE_SERVICES_JOBSPEC_ID, loadJobspec } from './jobspecs';
import { NomadClient } from './nomad.client';
import { NomadHttpError } from './nomad.errors';
import { DEFAULT_HARD_TIMEOUT_MS, DEFAULT_SOFT_TIMEOUT_MS, evaluateNomadStartup } from './startup-status';
import type {
  NomadAllocStub,
  NomadDriverInfo,
  NomadJobDetailTask,
  NomadJobDetailTaskGroup,
  NomadNodeDetail,
  NomadNodeStub,
  NomadParsedJob,
} from './types/nomad-api';

const ParsedJobIdSchema = z.object({ ID: z.string(), Name: z.string().optional() }).passthrough();
const PlanDiffTypeSchema = z.object({ Type: z.string() });

/** Serialize variables for Nomad parse. Strip `job_name` only for shipped jobspecs (plugin-level ID). */
function encodeVariables(variables: NomadVariables | undefined, stripJobName: boolean): string {
  if (!variables) return '';
  let hclVars: NomadVariables = variables;
  if (stripJobName) {
    const { job_name: _jobName, ...rest } = variables;
    hclVars = rest;
  }
  if (Object.keys(hclVars).length === 0) return '';
  return JSON.stringify(hclVars);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function mapNodeDrivers(drivers: Record<string, NomadDriverInfo> | null | undefined): NomadNode['drivers'] {
  const mapped: NomadNode['drivers'] = {};
  for (const [name, info] of Object.entries(drivers ?? {})) {
    mapped[name] = { detected: info.Detected ?? null, healthy: info.Healthy ?? null };
  }
  return mapped;
}

function mapNodeStub(node: NomadNodeStub): NomadNode {
  return {
    id: node.ID,
    name: node.Name,
    status: node.Status,
    schedulingEligibility: node.SchedulingEligibility,
    datacenter: node.Datacenter ?? null,
    nodePool: node.NodePool ?? null,
    address: node.Address ?? null,
    version: node.Version ?? null,
    drivers: mapNodeDrivers(node.Drivers),
    meta: null,
  };
}

function mapAllocStub(alloc: NomadAllocStub): NomadAllocSummary {
  return {
    id: alloc.ID,
    name: alloc.Name ?? null,
    nodeId: alloc.NodeID ?? null,
    nodeName: alloc.NodeName ?? null,
    clientStatus: alloc.ClientStatus,
    taskGroup: alloc.TaskGroup ?? null,
    tasks: Object.entries(alloc.TaskStates ?? {}).map(([task, state]) => ({
      task,
      state: state.State,
      failed: state.Failed,
      finishedAt: state.FinishedAt ?? null,
    })),
    createTime: alloc.CreateTime ?? null,
    modifyTime: alloc.ModifyTime ?? null,
  };
}

function mapJobTask(task: NomadJobDetailTask): NomadJobTask {
  return {
    task: task.Name ?? '',
    config: task.Config ?? null,
    resources: { cpu: task.Resources?.CPU ?? null, memoryMB: task.Resources?.MemoryMB ?? null },
    env: task.Env ?? null,
  };
}

function mapJobTaskGroup(group: NomadJobDetailTaskGroup): NomadJobTaskGroup {
  return { name: group.Name ?? '', tasks: (group.Tasks ?? []).map(mapJobTask) };
}

/** Detail reads carry Meta; agent version comes from Attributes["nomad.version"]. */
function mapNodeDetail(node: NomadNodeDetail): NomadNode {
  return {
    id: node.ID,
    name: node.Name,
    status: node.Status,
    schedulingEligibility: node.SchedulingEligibility,
    datacenter: node.Datacenter ?? null,
    nodePool: node.NodePool ?? null,
    address: node.HTTPAddr ?? null,
    version: node.Attributes?.['nomad.version'] ?? null,
    drivers: mapNodeDrivers(node.Drivers),
    meta: node.Meta ?? {},
  };
}

/** Resolve / validate / plan / submit / status / stop against NomadClient (no proprietary deps). */
@Injectable()
export class NomadJobsService {
  constructor(private readonly client: NomadClient) {}

  async validate(input: NomadJobRequest): Promise<NomadValidateResult> {
    let job: NomadParsedJob;
    let jobId: string | null = null;
    try {
      ({ job, jobId } = await this.resolveJob(input));
    } catch (error) {
      return { status: 'error', errors: [errorMessage(error)], warnings: null, jobId: null };
    }

    try {
      const response = await this.client.validateJob({ job, namespace: input.namespace });
      const validationErrors = response.ValidationErrors ?? [];
      const hasErrors = validationErrors.length > 0 || Boolean(response.Error);
      if (hasErrors) {
        const errors = response.Error ? [...validationErrors, response.Error] : validationErrors;
        return { status: 'error', errors, warnings: response.Warnings ?? null, job, jobId };
      }
      return { status: 'ok', warnings: response.Warnings ?? null, job, jobId };
    } catch (error) {
      return { status: 'error', errors: [errorMessage(error)], warnings: null, job, jobId };
    }
  }

  async plan(input: NomadJobRequest): Promise<NomadPlanResult> {
    let job: NomadParsedJob;
    let jobId: string;
    try {
      ({ job, jobId } = await this.resolveJob(input));
    } catch (error) {
      return {
        status: 'error',
        error: errorMessage(error),
        diffSummary: null,
        failedPlacements: false,
        warnings: null,
        jobId: null,
      };
    }

    try {
      const response = await this.client.planJob({
        jobId,
        job,
        namespace: input.namespace,
        diff: input.diff ?? true,
      });
      const failedPlacements = response.FailedTGAllocs != null && Object.keys(response.FailedTGAllocs).length > 0;
      const diffType = PlanDiffTypeSchema.safeParse(response.Diff);
      return {
        status: 'ok',
        error: null,
        diffSummary: diffType.success ? `plan ${diffType.data.Type.toLowerCase()}` : 'plan ok',
        failedPlacements,
        warnings: response.Warnings ?? null,
        jobId,
      };
    } catch (error) {
      return {
        status: 'error',
        error: errorMessage(error),
        diffSummary: null,
        failedPlacements: false,
        warnings: null,
        jobId,
      };
    }
  }

  /** Create-or-update via POST /v1/jobs; job id from parsed Job JSON (or job_name for shipped specs). */
  async submit(input: NomadJobRequest): Promise<NomadSubmitResult> {
    let job: NomadParsedJob;
    let jobId: string;
    try {
      ({ job, jobId } = await this.resolveJob(input));
    } catch (error) {
      return { status: 'error', error: errorMessage(error), evalId: null, jobId: null, submittedAt: null };
    }

    try {
      const response = await this.client.submitParsedJob({ job, namespace: input.namespace });
      return {
        status: 'ok',
        error: null,
        evalId: response.EvalID,
        jobId,
        submittedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        status: 'error',
        error: errorMessage(error),
        evalId: null,
        jobId,
        submittedAt: null,
      };
    }
  }

  async status(query: NomadStatusQuery): Promise<NomadStartupStatus> {
    const softTimeoutMs = query.softTimeoutMs ?? DEFAULT_SOFT_TIMEOUT_MS;
    const hardTimeoutMs = query.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS;
    const elapsedMs =
      query.elapsedMs ?? (query.submittedAt ? Math.max(0, Date.now() - Date.parse(query.submittedAt)) : 0);
    const oneShot = query.oneShot ?? false;

    try {
      const [allocations, job] = await Promise.all([
        this.client.getJobAllocations({ jobId: query.jobId, namespace: query.namespace }),
        this.client.getJob({ jobId: query.jobId, namespace: query.namespace }).catch(() => null),
      ]);

      const expectedTasksByGroup: Record<string, string[]> = {};
      for (const group of job?.TaskGroups ?? []) {
        expectedTasksByGroup[group.Name] = (group.Tasks ?? []).map((task) => task.Name);
      }

      return evaluateNomadStartup({
        allocations,
        elapsedMs,
        softTimeoutMs,
        hardTimeoutMs,
        oneShot,
        expectedTasksByGroup,
        jobStatus: job?.Status ?? null,
        jobVersion: job ? (job.Version ?? null) : null,
      });
    } catch (error) {
      if (error instanceof NomadHttpError && error.status === 404) {
        return {
          stage: 'failed',
          done: true,
          ok: false,
          tasks: [],
          failures: [`job not found: ${query.jobId}`],
          softTimeoutReached: elapsedMs >= softTimeoutMs,
          message: null,
        };
      }
      return {
        stage: 'failed',
        done: true,
        ok: false,
        tasks: [],
        failures: [errorMessage(error)],
        softTimeoutReached: elapsedMs >= softTimeoutMs,
        message: null,
      };
    }
  }

  /** List allocations for a job (dispatched child IDs included) via GET /v1/job/:jobId/allocations. */
  async allocs(query: NomadAllocsQuery): Promise<NomadAllocsResult> {
    try {
      const allocations = await this.client.getJobAllocations({ jobId: query.jobId, namespace: query.namespace });
      return { status: 'ok', error: null, jobId: query.jobId, allocs: allocations.map(mapAllocStub) };
    } catch (error) {
      return { status: 'error', error: errorMessage(error), jobId: query.jobId, allocs: [] };
    }
  }

  /** Read a registered job's task Config/Resources/Env via GET /v1/job/:jobId (deploy prefill). */
  async readJob(query: NomadJobQuery): Promise<NomadJobReadResult> {
    try {
      const job = await this.client.readJob({ jobId: query.jobId, namespace: query.namespace });
      return {
        status: 'ok',
        error: null,
        jobId: query.jobId,
        name: job.Name ?? null,
        jobStatus: job.Status ?? null,
        taskGroups: (job.TaskGroups ?? []).map(mapJobTaskGroup),
      };
    } catch (error) {
      return {
        status: 'error',
        error: errorMessage(error),
        jobId: query.jobId,
        name: null,
        jobStatus: null,
        taskGroups: [],
      };
    }
  }

  /** Dispatch a parameterized job via POST /v1/job/:jobId/dispatch (payload base64-encoded in client). */
  async dispatch(input: NomadDispatchRequest): Promise<NomadDispatchResult> {
    try {
      const response = await this.client.dispatchJob({
        jobId: input.jobId,
        meta: input.meta,
        payload: input.payload,
        namespace: input.namespace,
      });
      return {
        status: 'ok',
        error: null,
        dispatchedJobId: response.DispatchedJobID,
        evalId: response.EvalID,
        jobId: input.jobId,
      };
    } catch (error) {
      return {
        status: 'error',
        error: errorMessage(error),
        dispatchedJobId: null,
        evalId: null,
        jobId: input.jobId,
      };
    }
  }

  /** Bounded single-shot log tail via GET /v1/client/fs/logs/:allocId (plain=true, follow=false). */
  async logs(query: NomadLogsQuery): Promise<NomadLogsResult> {
    const { allocId, task, type, origin, offset } = query;
    try {
      const text = await this.client.getAllocLogs({
        allocId,
        task,
        type,
        origin,
        offset,
        namespace: query.namespace,
      });
      return { status: 'ok', error: null, text, allocId, task, type, origin, offset };
    } catch (error) {
      return { status: 'error', error: errorMessage(error), text: null, allocId, task, type, origin, offset };
    }
  }

  /** List nodes via GET /v1/nodes, or one node (with Meta) via GET /v1/node/:id when nodeId is set. */
  async nodes(query: NomadNodesQuery): Promise<NomadNodesResult> {
    try {
      if (query.nodeId) {
        const node = await this.client.getNode({ nodeId: query.nodeId });
        return { status: 'ok', error: null, nodes: [mapNodeDetail(node)] };
      }
      const nodes = await this.client.listNodes();
      return { status: 'ok', error: null, nodes: nodes.map(mapNodeStub) };
    } catch (error) {
      return { status: 'error', error: errorMessage(error), nodes: [] };
    }
  }

  /** Stop/deregister via Nomad DELETE /v1/job/{id}; purge=true also removes GC history. */
  async stop(input: NomadStopRequest): Promise<NomadStopResult> {
    const purge = input.purge ?? false;
    try {
      const response = await this.client.deregisterJob({
        jobId: input.jobId,
        namespace: input.namespace,
        purge,
      });
      return {
        status: 'ok',
        error: null,
        evalId: response.EvalID,
        jobId: input.jobId,
        purge,
      };
    } catch (error) {
      return {
        status: 'error',
        error: errorMessage(error),
        evalId: null,
        jobId: input.jobId,
        purge,
      };
    }
  }

  private async resolveJob(input: NomadJobRequest): Promise<{ job: NomadParsedJob; jobId: string }> {
    if (input.job) {
      const jobId = ParsedJobIdSchema.parse(input.job).ID;
      return { job: input.job, jobId };
    }

    // Inline jobHCL: variables pass through and the parsed Job.ID wins. Shipped jobspec: strip
    // plugin-only job_name, override ID post-parse (HCL labels can't interpolate), align Namespace.
    const usesShippedJobspec = input.jobHCL === undefined;
    const effectiveNamespace = input.namespace ?? this.client.defaultNamespace;
    const jobHCL = input.jobHCL ?? loadJobspec(input.jobspecId ?? BRIDGE_SERVICES_JOBSPEC_ID);
    const variablesForParse = usesShippedJobspec
      ? { ...input.variables, namespace: effectiveNamespace }
      : input.variables;
    const parsed = ParsedJobIdSchema.parse(
      await this.client.parseJob({
        jobHCL,
        variables: encodeVariables(variablesForParse, usesShippedJobspec),
        namespace: input.namespace,
      }),
    );
    if (!usesShippedJobspec) {
      if (input.namespace) {
        return { job: { ...parsed, Namespace: input.namespace }, jobId: parsed.ID };
      }
      return { job: parsed, jobId: parsed.ID };
    }
    const fromVar = input.variables?.job_name;
    const jobId = typeof fromVar === 'string' && fromVar.length > 0 ? fromVar : parsed.ID;
    const job: NomadParsedJob = {
      ...parsed,
      ID: jobId,
      Name: jobId,
      Namespace: effectiveNamespace,
    };
    return { job, jobId };
  }
}
