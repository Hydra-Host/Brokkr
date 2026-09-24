import type { RenderReason } from '../device-record/atom/render-request.schema';

export interface ErrorWrapper {
  message: string;
}

export interface ResultPayload {
  plan_id: string;
  step_name: string;
  operation: string | null;
  status: string;
  device_id: string;
  zone_prefix: string;
  event_type: string;
  action_type: string;
  result: Record<string, unknown> | null;
  error: ErrorWrapper | null;
  attempt: number;
  metadata: Record<string, unknown> | null;
  timestamp: number;
}

export interface JobCompletedPayload {
  plan_id: string;
  device_id: string;
  zone_prefix: string;
  saga_name: string;
  status: string;
  duration_seconds: number | null;
  error: ErrorWrapper | null;
  metadata: Record<string, unknown> | null;
  timestamp: number;
}

export interface DiscoveryCompletePayload {
  device_id: string;
  zone_prefix: string;
  fields: string[];
  job_id: string | null;
  timestamp: number;
}

export interface PhoneHomePayload {
  device_id: string;
  zone_prefix: string;
  boot_id: string;
  timestamp: number;
}

export interface RenderRequestPayload {
  request_id: string;
  zone_id: string;
  bridge_id: string;
  domain: string;
  params?: Record<string, unknown>;
  reason?: RenderReason;
}

export interface BuildResultPayloadArgs {
  plan_id: string;
  step_name: string;
  operation?: string | null;
  status: string;
  device_id: unknown;
  zone_prefix: string;
  event_type?: string;
  action_type: string;
  result?: Record<string, unknown> | null;
  error?: string | null;
  attempt?: number;
  metadata?: Record<string, unknown> | null;
  timestamp: number;
}

export function buildResultPayload(args: BuildResultPayloadArgs): ResultPayload {
  return {
    plan_id: args.plan_id,
    step_name: args.step_name,
    operation: args.operation ?? null,
    status: args.status,
    device_id: String(args.device_id),
    zone_prefix: args.zone_prefix,
    event_type: args.event_type ?? 'stage_changed',
    action_type: args.action_type,
    result: args.result ?? null,
    error: args.error ? { message: args.error } : null,
    attempt: args.attempt ?? 0,
    metadata: args.metadata ?? null,
    timestamp: args.timestamp,
  };
}

export interface BuildJobCompletedPayloadArgs {
  plan_id: string;
  device_id: unknown;
  saga_name: string;
  status: string;
  zone_prefix: string;
  duration_seconds?: number | null;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
  timestamp: number;
}

export function buildJobCompletedPayload(args: BuildJobCompletedPayloadArgs): JobCompletedPayload {
  return {
    plan_id: args.plan_id,
    device_id: String(args.device_id),
    zone_prefix: args.zone_prefix,
    saga_name: args.saga_name,
    status: args.status,
    duration_seconds: args.duration_seconds ?? null,
    error: args.error ? { message: args.error } : null,
    metadata: args.metadata ?? null,
    timestamp: args.timestamp,
  };
}

export interface BuildDiscoveryCompletePayloadArgs {
  device_id: string;
  fields: string[];
  zone_prefix: string;
  job_id?: string | null;
  timestamp: number;
}

export function buildDiscoveryCompletePayload(args: BuildDiscoveryCompletePayloadArgs): DiscoveryCompletePayload {
  return {
    device_id: String(args.device_id),
    zone_prefix: args.zone_prefix,
    fields: args.fields,
    job_id: args.job_id === undefined ? 'discovery' : args.job_id,
    timestamp: args.timestamp,
  };
}

export interface BuildPhoneHomePayloadArgs {
  device_id: string;
  zone_prefix: string;
  boot_id: string;
  timestamp: number;
}

export function buildPhoneHomePayload(args: BuildPhoneHomePayloadArgs): PhoneHomePayload {
  return {
    device_id: String(args.device_id),
    zone_prefix: args.zone_prefix,
    boot_id: args.boot_id,
    timestamp: args.timestamp,
  };
}

export interface BuildRenderRequestPayloadArgs {
  request_id: string;
  zone_id: string;
  bridge_id: string;
  domain: string;
  entity_id?: string | null;
  params?: Record<string, unknown> | null;
  reason?: RenderReason | null;
}

export function buildRenderRequestPayload(args: BuildRenderRequestPayloadArgs): RenderRequestPayload {
  const payload: RenderRequestPayload = {
    request_id: args.request_id,
    zone_id: args.zone_id,
    bridge_id: args.bridge_id,
    domain: args.domain,
  };

  let mergedParams: Record<string, unknown> | undefined;
  if (args.entity_id !== undefined && args.entity_id !== null) {
    mergedParams = { ...(args.params ?? {}) };
    if (!('entity_id' in mergedParams)) {
      mergedParams.entity_id = args.entity_id;
    }
  } else if (args.params !== undefined && args.params !== null) {
    mergedParams = { ...args.params };
  }

  if (mergedParams !== undefined) {
    payload.params = mergedParams;
  }
  if (args.reason !== undefined && args.reason !== null) {
    payload.reason = args.reason;
  }

  return payload;
}
