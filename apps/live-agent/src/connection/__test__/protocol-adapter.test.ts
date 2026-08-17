import { create } from '@bufbuild/protobuf';
import { DurationSchema } from '@bufbuild/protobuf/wkt';
import { describe, expect, it } from 'vitest';
import {
  PartialResult_Status,
  WorkRequestSchema as ProtoWorkRequestSchema,
  WorkResponse_Status,
} from '../../gen/brokkr/agent/v1/work_pb';
import {
  bytesToJson,
  durationToMs,
  jsonToBytes,
  msToDuration,
  protoToZodWorkRequest,
  zodCollectionResultToPartialResult,
  zodWorkProgressToProto,
  zodWorkResponseToProto,
} from '.././protocol-adapter';

import type { CollectionResult, WorkProgress, WorkResponse } from '@repo/bridge-agent-protocol';

describe('protocol-adapter', () => {
  describe('jsonToBytes / bytesToJson', () => {
    it('round-trips an object', () => {
      const obj = { foo: 'bar', n: 42 };
      const bytes = jsonToBytes(obj);
      expect(bytesToJson(bytes)).toEqual(obj);
    });

    it('returns undefined for empty bytes', () => {
      expect(bytesToJson(new Uint8Array())).toBeUndefined();
    });
  });

  describe('durationToMs / msToDuration', () => {
    it('converts ms to duration and back', () => {
      const ms = 5500;
      const dur = msToDuration(ms);
      expect(dur.seconds).toBe(5n);
      expect(dur.nanos).toBe(500_000_000);
      const protoDur = create(DurationSchema, dur);
      expect(durationToMs(protoDur)).toBe(ms);
    });

    it('returns undefined for absent duration', () => {
      expect(durationToMs(undefined)).toBeUndefined();
    });
  });

  describe('protoToZodWorkRequest', () => {
    it('converts a proto WorkRequest to the zod shape', () => {
      const input = { disks: ['/dev/sda'] };
      const proto = create(ProtoWorkRequestSchema, {
        workId: 'abc-123',
        operation: 'storage.wipeDisk',
        input: jsonToBytes(input),
        jobId: 'job-456',
        deadline: { seconds: 300n, nanos: 0 },
        serverId: 'bridge-1',
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        tracestate: 'vendor=value',
      });

      const result = protoToZodWorkRequest(proto);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.request.type).toBe('work.request');
      expect(result.request.work_id).toBe('abc-123');
      expect(result.request.operation).toBe('storage.wipeDisk');
      expect(result.request.input).toEqual(input);
      expect(result.request.job_id).toBe('job-456');
      expect(result.request.timeout_ms).toBe(300_000);
      expect(result.request.traceparent).toBe('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
      expect(result.request.tracestate).toBe('vendor=value');
    });

    it('handles missing optional fields', () => {
      const proto = create(ProtoWorkRequestSchema, {
        workId: 'abc-123',
        operation: 'test.noop',
        input: new Uint8Array(),
      });

      const result = protoToZodWorkRequest(proto);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.request.job_id).toBeUndefined();
      expect(result.request.timeout_ms).toBeUndefined();
      expect(result.request.input).toBeUndefined();
      expect(result.request.traceparent).toBeUndefined();
      expect(result.request.tracestate).toBeUndefined();
    });

    it('passes through unknown operation strings without throwing', () => {
      const proto = create(ProtoWorkRequestSchema, {
        workId: 'abc-unknown',
        operation: 'nonsense.bogus',
        input: new Uint8Array(),
      });

      const result = protoToZodWorkRequest(proto);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.request.operation).toBe('nonsense.bogus');
      expect(result.request.work_id).toBe('abc-unknown');
    });

    it('returns failure response for malformed JSON input instead of throwing (poison-pill)', () => {
      const proto = create(ProtoWorkRequestSchema, {
        workId: 'bad-input-001',
        operation: 'storage.wipeDisk',
        input: new TextEncoder().encode('not valid json {{{'),
      });

      const result = protoToZodWorkRequest(proto);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.response.type).toBe('work.response');
      expect(result.response.work_id).toBe('bad-input-001');
      expect(result.response.status).toBe('failure');
      expect(result.response.error?.code).toBe('INVALID_INPUT');
      expect(result.response.error?.message).toContain('not valid JSON');
    });

    it('re-throws non-SyntaxError exceptions from bytesToJson', () => {
      const proto = create(ProtoWorkRequestSchema, {
        workId: 'err-001',
        operation: 'test.noop',
        input: new Uint8Array(),
      });
      Object.defineProperty(proto, 'input', {
        get() {
          throw new TypeError('simulated non-JSON error');
        },
      });

      expect(() => protoToZodWorkRequest(proto)).toThrow(TypeError);
    });
  });

  describe('zodWorkResponseToProto', () => {
    it('converts a success response', () => {
      const zod: WorkResponse = {
        type: 'work.response',
        work_id: 'abc-123',
        status: 'success',
        output: { ok: true },
      };

      const proto = zodWorkResponseToProto(zod);

      expect(proto.workId).toBe('abc-123');
      expect(proto.status).toBe(WorkResponse_Status.SUCCESS);
      expect(bytesToJson(proto.output)).toEqual({ ok: true });
      expect(proto.error).toBeUndefined();
    });

    it('converts a failure response with error details', () => {
      const zod: WorkResponse = {
        type: 'work.response',
        work_id: 'abc-123',
        status: 'failure',
        error: { code: 'TIMEOUT', message: 'timed out', details: { elapsed: 300 } },
      };

      const proto = zodWorkResponseToProto(zod);

      expect(proto.status).toBe(WorkResponse_Status.FAILURE);
      expect(proto.error?.code).toBe('TIMEOUT');
      expect(proto.error?.message).toBe('timed out');
      expect(JSON.parse(proto.error!.detailsJson)).toEqual({ elapsed: 300 });
    });
  });

  describe('zodWorkProgressToProto', () => {
    it('converts a progress report', () => {
      const zod: WorkProgress = {
        type: 'work.progress',
        work_id: 'abc-123',
        progress: 0.42,
        message: 'wiping disk 3/8',
      };

      const proto = zodWorkProgressToProto(zod);

      expect(proto.workId).toBe('abc-123');
      expect(proto.progress).toBeCloseTo(0.42);
      expect(proto.message).toBe('wiping disk 3/8');
    });

    it('defaults message to empty string when absent', () => {
      const zod: WorkProgress = {
        type: 'work.progress',
        work_id: 'abc-123',
        progress: 0.5,
      };

      const proto = zodWorkProgressToProto(zod);

      expect(proto.message).toBe('');
    });
  });

  describe('zodCollectionResultToPartialResult', () => {
    it('converts a success collection result', () => {
      const zod: CollectionResult = {
        type: 'collection.result',
        work_id: 'abc-123',
        collector: 'lsblk',
        status: 'success',
        data: { blockdevices: [] },
        duration_ms: 1234,
      };

      const proto = zodCollectionResultToPartialResult(zod);

      expect(proto.workId).toBe('abc-123');
      expect(proto.unit).toBe('lsblk');
      expect(proto.status).toBe(PartialResult_Status.SUCCESS);
      expect(bytesToJson(proto.data)).toEqual({ blockdevices: [] });
      expect(proto.duration?.seconds).toBe(1n);
      expect(proto.duration?.nanos).toBe(234_000_000);
    });

    it('converts a failure collection result with error', () => {
      const zod: CollectionResult = {
        type: 'collection.result',
        work_id: 'abc-123',
        collector: 'nvidia_detailed',
        status: 'failure',
        error: { code: 'MISSING_BINARY', message: 'nvidia-smi not found' },
      };

      const proto = zodCollectionResultToPartialResult(zod);

      expect(proto.status).toBe(PartialResult_Status.FAILURE);
      expect(proto.error?.code).toBe('MISSING_BINARY');
      expect(proto.error?.message).toBe('nvidia-smi not found');
    });
  });
});
