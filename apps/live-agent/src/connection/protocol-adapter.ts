import { create } from '@bufbuild/protobuf';
import type { Duration } from '@bufbuild/protobuf/wkt';
import type { WorkRequest as ProtoWorkRequest } from '../gen/brokkr/agent/v1/work_pb';
import {
  PartialResult_Status,
  OperationErrorSchema as ProtoOperationErrorSchema,
  PartialResultSchema as ProtoPartialResultSchema,
  WorkProgressSchema as ProtoWorkProgressSchema,
  WorkResponseSchema as ProtoWorkResponseSchema,
  WorkResponse_Status,
} from '../gen/brokkr/agent/v1/work_pb';

import type {
  CollectionResult as ZodCollectionResult,
  OperationError as ZodOperationError,
  WorkProgress as ZodWorkProgress,
  WorkRequest as ZodWorkRequest,
  WorkResponse as ZodWorkResponse,
} from '@repo/bridge-agent-protocol';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function jsonToBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function bytesToJson(bytes: Uint8Array): unknown {
  if (bytes.length === 0) return undefined;
  return JSON.parse(decoder.decode(bytes));
}

function durationToMs(d: Duration | undefined): number | undefined {
  if (!d) return undefined;
  return Number(d.seconds) * 1000 + Math.trunc(d.nanos / 1_000_000);
}

function msToDuration(ms: number): { seconds: bigint; nanos: number } {
  // trunc, not floor — floor rounds negative ms toward -∞, breaking forward/reverse symmetry.
  const seconds = BigInt(Math.trunc(ms / 1000));
  const nanos = (ms % 1000) * 1_000_000;
  return { seconds, nanos };
}

export type ProtoToZodResult = { ok: true; request: ZodWorkRequest } | { ok: false; response: ZodWorkResponse };

function invalidInputResponse(workId: string, message: string): ZodWorkResponse {
  const error: ZodOperationError = {
    code: 'INVALID_INPUT',
    message,
  };
  return {
    type: 'work.response' as const,
    work_id: workId,
    status: 'failure' as const,
    error,
  };
}

export function protoToZodWorkRequest(proto: ProtoWorkRequest): ProtoToZodResult {
  let input: unknown;
  try {
    input = bytesToJson(proto.input);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return {
        ok: false,
        response: invalidInputResponse(proto.workId, `WorkRequest.input is not valid JSON: ${err.message}`),
      };
    }
    throw err;
  }
  return {
    ok: true,
    request: {
      type: 'work.request' as const,
      work_id: proto.workId,
      operation: proto.operation,
      input,
      job_id: proto.jobId || undefined,
      timeout_ms: durationToMs(proto.deadline),
      traceparent: proto.traceparent || undefined,
      tracestate: proto.tracestate || undefined,
    },
  };
}

export function zodWorkResponseToProto(zod: ZodWorkResponse) {
  return create(ProtoWorkResponseSchema, {
    workId: zod.work_id,
    status: zod.status === 'success' ? WorkResponse_Status.SUCCESS : WorkResponse_Status.FAILURE,
    output: zod.output !== undefined ? jsonToBytes(zod.output) : new Uint8Array(),
    ...(zod.error ? { error: zodOperationErrorToProto(zod.error) } : {}),
  });
}

export function zodWorkProgressToProto(zod: ZodWorkProgress) {
  return create(ProtoWorkProgressSchema, {
    workId: zod.work_id,
    progress: zod.progress,
    message: zod.message ?? '',
  });
}

export function zodCollectionResultToPartialResult(zod: ZodCollectionResult) {
  return create(ProtoPartialResultSchema, {
    workId: zod.work_id,
    unit: zod.collector,
    status: zod.status === 'success' ? PartialResult_Status.SUCCESS : PartialResult_Status.FAILURE,
    data: zod.data !== undefined ? jsonToBytes(zod.data) : new Uint8Array(),
    ...(zod.error ? { error: zodOperationErrorToProto(zod.error) } : {}),
    ...(zod.duration_ms !== undefined ? { duration: msToDuration(zod.duration_ms) } : {}),
  });
}

function zodOperationErrorToProto(zod: { code: string; message: string; details?: unknown }) {
  return create(ProtoOperationErrorSchema, {
    code: zod.code,
    message: zod.message,
    detailsJson:
      zod.details !== undefined
        ? (() => {
            try {
              return JSON.stringify(zod.details);
            } catch {
              return JSON.stringify({ unserializable: String(zod.details) });
            }
          })()
        : '',
  });
}

export { bytesToJson, durationToMs, invalidInputResponse, jsonToBytes, msToDuration };
