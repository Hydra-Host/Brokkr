import { describe, expect, it } from 'vitest';

import {
  bytesToHex,
  decodeWorkResponse,
  encodePartialResult,
  encodeWorkResponse,
  hexToBytes,
  WorkResponseStatus,
  type OperationErrorFields,
  type PartialResultFields,
  type WorkResponseFields,
} from '../protobuf-codec';

const TEXT_ENCODER = new TextEncoder();

const EMPTY_ERROR: OperationErrorFields = { code: '', message: '', detailsJson: '' };

const GOLDEN = {
  success: '0a0e776f726b2d737563636573732d3110011a147b226d616368696e65223a227838365f3634227d',
  failure:
    '0a0e776f726b2d6661696c7572652d311002223b0a0e4d495353494e475f42494e415259120e6d6b6673206e6f7420666f756e641a197b22737464657272223a226e6f20737563682066696c65227d',
  aip: '0a0a776f726b2d6169702d311003',
  partial:
    '0a0e776f726b2d7061727469616c2d31120c617263686974656374757265180122107b2261726368223a22616d643634227d3208082a1080cab5ee01',
  partialFail: '0a0e776f726b2d7061727469616c2d3212056c73626c6b18022a130a0754494d454f55541208746f6f20736c6f773202107b',
} as const;

describe('encodeWorkResponse <-> decodeWorkResponse round-trip', () => {
  const cases: Array<{ name: string; value: WorkResponseFields }> = [
    {
      name: 'SUCCESS with non-empty output',
      value: {
        workId: 'work-success-1',
        status: WorkResponseStatus.SUCCESS,
        output: TEXT_ENCODER.encode('{"machine":"x86_64"}'),
        error: EMPTY_ERROR,
      },
    },
    {
      name: 'FAILURE with a populated OperationError',
      value: {
        workId: 'work-failure-1',
        status: WorkResponseStatus.FAILURE,
        output: new Uint8Array(),
        error: {
          code: 'MISSING_BINARY',
          message: 'mkfs not found',
          detailsJson: '{"stderr":"no such file"}',
        },
      },
    },
    {
      name: 'ALREADY_IN_PROGRESS with empty output and error',
      value: {
        workId: 'work-aip-1',
        status: WorkResponseStatus.ALREADY_IN_PROGRESS,
        output: new Uint8Array(),
        error: EMPTY_ERROR,
      },
    },
  ];

  for (const { name, value } of cases) {
    it(`round-trips ${name}`, () => {
      const decoded = decodeWorkResponse(encodeWorkResponse(value));

      expect(decoded.workId).toBe(value.workId);
      expect(decoded.status).toBe(value.status);
      expect(decoded.output).toEqual(value.output);
      expect(decoded.error).toEqual(value.error);
    });
  }

  it('elides empty workId/output and an empty OperationError sub-message', () => {
    const encoded = encodeWorkResponse({
      workId: '',
      status: WorkResponseStatus.SUCCESS,
      output: new Uint8Array(),
      error: EMPTY_ERROR,
    });

    expect(bytesToHex(encoded)).toBe('1001');

    const decoded = decodeWorkResponse(encoded);
    expect(decoded.workId).toBe('');
    expect(decoded.output).toEqual(new Uint8Array());
    expect(decoded.error).toEqual(EMPTY_ERROR);
  });
});

describe('wire format pinned against the protoc-gen-es golden vectors', () => {
  it('encodeWorkResponse matches the bufbuild bytes for SUCCESS', () => {
    const encoded = encodeWorkResponse({
      workId: 'work-success-1',
      status: WorkResponseStatus.SUCCESS,
      output: TEXT_ENCODER.encode('{"machine":"x86_64"}'),
      error: EMPTY_ERROR,
    });

    expect(bytesToHex(encoded)).toBe(GOLDEN.success);
  });

  it('encodeWorkResponse matches the bufbuild bytes for FAILURE + OperationError', () => {
    const encoded = encodeWorkResponse({
      workId: 'work-failure-1',
      status: WorkResponseStatus.FAILURE,
      output: new Uint8Array(),
      error: {
        code: 'MISSING_BINARY',
        message: 'mkfs not found',
        detailsJson: '{"stderr":"no such file"}',
      },
    });

    expect(bytesToHex(encoded)).toBe(GOLDEN.failure);
  });

  it('encodeWorkResponse matches the bufbuild bytes for ALREADY_IN_PROGRESS', () => {
    const encoded = encodeWorkResponse({
      workId: 'work-aip-1',
      status: WorkResponseStatus.ALREADY_IN_PROGRESS,
      output: new Uint8Array(),
      error: EMPTY_ERROR,
    });

    expect(bytesToHex(encoded)).toBe(GOLDEN.aip);
  });

  it('decodeWorkResponse reads the bufbuild FAILURE bytes back to fields', () => {
    const decoded = decodeWorkResponse(hexToBytes(GOLDEN.failure));

    expect(decoded.workId).toBe('work-failure-1');
    expect(decoded.status).toBe(WorkResponseStatus.FAILURE);
    expect(decoded.error).toEqual({
      code: 'MISSING_BINARY',
      message: 'mkfs not found',
      detailsJson: '{"stderr":"no such file"}',
    });
  });
});

describe('encodePartialResult', () => {
  it('matches the bufbuild bytes for SUCCESS with a non-zero field-6 Duration', () => {
    const partial: PartialResultFields = {
      workId: 'work-partial-1',
      unit: 'architecture',
      status: 1,
      data: TEXT_ENCODER.encode('{"arch":"amd64"}'),
      error: EMPTY_ERROR,
      duration: { seconds: 42, nanos: 500000000 },
    };

    expect(bytesToHex(encodePartialResult(partial))).toBe(GOLDEN.partial);
  });

  it('matches the bufbuild bytes for FAILURE with error and a nanos-only Duration', () => {
    const partial: PartialResultFields = {
      workId: 'work-partial-2',
      unit: 'lsblk',
      status: 2,
      data: new Uint8Array(),
      error: { code: 'TIMEOUT', message: 'too slow', detailsJson: '' },
      duration: { seconds: 0, nanos: 123 },
    };

    expect(bytesToHex(encodePartialResult(partial))).toBe(GOLDEN.partialFail);
  });

  it('omits the field-6 Duration entirely when seconds and nanos are both zero', () => {
    const partial: PartialResultFields = {
      workId: 'w',
      unit: '',
      status: 0,
      data: new Uint8Array(),
      error: EMPTY_ERROR,
      duration: { seconds: 0, nanos: 0 },
    };

    const hex = bytesToHex(encodePartialResult(partial));
    expect(hex).toBe('0a0177');
    expect(hex).not.toContain('32');
  });
});

describe('Reader edge cases', () => {
  it('throws on a truncated varint (status field cut mid-stream)', () => {
    const truncatedVarint = new Uint8Array([0x10, 0x80]);

    expect(() => decodeWorkResponse(truncatedVarint)).toThrow('truncated varint');
  });

  it('throws on an over-long varint (more than 10 bytes)', () => {
    const overLong = new Uint8Array([0x10, ...new Array(11).fill(0x80)]);

    expect(() => decodeWorkResponse(overLong)).toThrow('varint too long');
  });

  it('skips an unknown field (wire type 0) and still decodes known fields', () => {
    const withUnknownVarint = new Uint8Array([0x38, 0x09, 0x10, 0x01]);

    const decoded = decodeWorkResponse(withUnknownVarint);
    expect(decoded.status).toBe(WorkResponseStatus.SUCCESS);
  });

  it('skips an unknown length-delimited field (wire type 2)', () => {
    const withUnknownBytes = new Uint8Array([0x2a, 0x02, 0x41, 0x42, 0x10, 0x02]);

    const decoded = decodeWorkResponse(withUnknownBytes);
    expect(decoded.status).toBe(WorkResponseStatus.FAILURE);
  });

  it('skips an unknown fixed64 field (wire type 1) and decodes the rest', () => {
    const withFixed64 = new Uint8Array([0x49, 0, 0, 0, 0, 0, 0, 0, 0, 0x10, 0x03]);

    const decoded = decodeWorkResponse(withFixed64);
    expect(decoded.status).toBe(WorkResponseStatus.ALREADY_IN_PROGRESS);
  });

  it('throws on an unsupported wire type (group/3)', () => {
    const startGroup = new Uint8Array([0x0b]);

    expect(() => decodeWorkResponse(startGroup)).toThrow('unsupported wire type 3');
  });
});

describe('hex helpers', () => {
  it('round-trip bytesToHex/hexToBytes', () => {
    const bytes = new Uint8Array([0x00, 0x0a, 0xff, 0x10, 0x7f, 0x80]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });

  it('rejects odd-length hex', () => {
    expect(() => hexToBytes('abc')).toThrow('odd-length hex');
  });
});
