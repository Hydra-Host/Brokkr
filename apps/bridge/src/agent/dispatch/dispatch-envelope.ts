import { createHash, randomUUID } from 'node:crypto';

import { operations, type OperationName, type OperationOutput } from '@repo/bridge-agent-protocol';

import { DispatchFailed } from './grpc.exceptions';
import { WorkResponseStatus, decodeWorkResponse, type WorkResponseFields } from './protobuf-codec';
const TEXT_ENCODER = new TextEncoder();

export type WorkIdFactory = () => string;

export interface DispatchEnvelopeInput {
  workId: string | null;
  deviceId: string;
  operation: string;
  input: unknown;
  effectiveTimeout: number;
  jobId: string | null;
  workIdFactory?: WorkIdFactory;
}

export interface DispatchWorkRequestFields {
  workId: string;
  operation: string;
  input: Uint8Array;
  jobId: string;
  deadline: { seconds: number; nanos: number };
  traceparent?: string;
  tracestate?: string;
}

export interface DispatchEnvelope {
  workIdStr: string;
  inputHash: string;
  workRequest: DispatchWorkRequestFields;
}

export function buildDispatchEnvelope(args: DispatchEnvelopeInput): DispatchEnvelope {
  const factory = args.workIdFactory ?? (() => randomUUID());
  const workIdStr = args.workId !== null ? args.workId : factory();

  let payload: Uint8Array;
  if (args.input === null || args.input === undefined) {
    payload = TEXT_ENCODER.encode('{}');
  } else {
    let encoded: string;
    try {
      encoded = JSON.stringify(args.input);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new DispatchFailed(
        'INVALID_INPUT',
        `input is not JSON-serializable for operation '${args.operation}' on device '${args.deviceId}': ${reason}`,
        null,
      );
    }
    payload = TEXT_ENCODER.encode(encoded);
  }

  const inputHash = createHash('sha256').update(payload).digest('hex');
  const deadline = secondsToDuration(args.effectiveTimeout);

  const workRequest: DispatchWorkRequestFields = {
    workId: workIdStr,
    operation: args.operation,
    input: payload,
    jobId: args.jobId ?? '',
    deadline,
  };

  return { workIdStr, inputHash, workRequest };
}

function secondsToDuration(seconds: number): { seconds: number; nanos: number } {
  const totalMicros = Math.round(seconds * 1_000_000);
  const wholeSeconds = Math.trunc(totalMicros / 1_000_000);
  const remainderMicros = totalMicros - wholeSeconds * 1_000_000;
  return { seconds: wholeSeconds, nanos: remainderMicros * 1000 };
}

export type ParseResponseOutcome = { kind: 'response'; response: WorkResponseFields } | { kind: 'inProgress' };

export function parseResponseOrRaise(
  blob: Uint8Array,
  workIdStr: string,
  options: { allowInProgress: boolean },
): ParseResponseOutcome {
  const response = decodeWorkResponse(blob);

  if (response.status === WorkResponseStatus.FAILURE) {
    const err = response.error;
    throw new DispatchFailed(err.code || 'UNKNOWN', err.message || 'agent reported failure', err.detailsJson || null);
  }

  if (response.status === WorkResponseStatus.ALREADY_IN_PROGRESS) {
    if (options.allowInProgress) return { kind: 'inProgress' };
    throw new DispatchFailed(
      'DISPATCH_INVARIANT',
      `work_id=${workIdStr} returned STATUS_ALREADY_IN_PROGRESS where a ` +
        'terminal SUCCESS/FAILURE was expected; indicates IN_PROGRESS leaked ' +
        'into the terminal-result Redis key',
      null,
    );
  }

  return { kind: 'response', response };
}

export function extractOutput(response: WorkResponseFields): unknown {
  if (response.output.length === 0) return null;
  const text = new TextDecoder().decode(response.output);
  try {
    return JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DispatchFailed('DECODE_ERROR', `agent output was not valid JSON: ${reason}`, null);
  }
}

export function validateOperationOutput<N extends OperationName>(operation: N, raw: unknown): OperationOutput<N> {
  const schema = operations[operation]?.output;
  if (schema === undefined) {
    // Defensive: an operation without an output schema surfaces raw rather than crashing the dispatch boundary.
    return raw as OperationOutput<N>;
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
      .join('; ');
    throw new DispatchFailed(
      'OUTPUT_VALIDATION',
      `agent response for operation '${operation}' did not match its protocol output schema: ${detail}`,
      null,
    );
  }

  return result.data;
}
