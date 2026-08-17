// Field numbers + wire types must match proto/brokkr/agent/v1/{agent,work}.proto; hand-rolled to avoid pulling in @bufbuild/protobuf.

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export interface DurationFields {
  seconds: number;
  nanos: number;
}

export enum WorkResponseStatus {
  UNSPECIFIED = 0,
  SUCCESS = 1,
  FAILURE = 2,
  ALREADY_IN_PROGRESS = 3,
}

export interface OperationErrorFields {
  code: string;
  message: string;
  detailsJson: string;
}

export interface WorkResponseFields {
  workId: string;
  status: WorkResponseStatus;
  output: Uint8Array;
  error: OperationErrorFields;
}

class Writer {
  private chunks: Uint8Array[] = [];
  private length = 0;

  writeVarint(value: number | bigint): void {
    let v = typeof value === 'bigint' ? value : BigInt(value);
    if (v < 0n) v += 1n << 64n;
    const bytes: number[] = [];
    while (v >= 0x80n) {
      bytes.push(Number(v & 0x7fn) | 0x80);
      v >>= 7n;
    }
    bytes.push(Number(v));
    const arr = new Uint8Array(bytes);
    this.chunks.push(arr);
    this.length += arr.length;
  }

  writeTag(fieldNumber: number, wireType: number): void {
    this.writeVarint((fieldNumber << 3) | wireType);
  }

  writeBytes(value: Uint8Array): void {
    this.writeVarint(value.length);
    this.chunks.push(value);
    this.length += value.length;
  }

  writeString(value: string): void {
    this.writeBytes(TEXT_ENCODER.encode(value));
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let off = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, off);
      off += chunk.length;
    }
    return out;
  }
}

function encodeDuration(d: DurationFields): Uint8Array {
  const w = new Writer();
  if (d.seconds !== 0) {
    w.writeTag(1, 0);
    w.writeVarint(d.seconds);
  }
  if (d.nanos !== 0) {
    w.writeTag(2, 0);
    w.writeVarint(d.nanos);
  }
  return w.finish();
}

function operationErrorIsEmpty(e: OperationErrorFields): boolean {
  return e.code === '' && e.message === '' && e.detailsJson === '';
}

function encodeOperationError(e: OperationErrorFields): Uint8Array {
  const w = new Writer();
  if (e.code !== '') {
    w.writeTag(1, 2);
    w.writeString(e.code);
  }
  if (e.message !== '') {
    w.writeTag(2, 2);
    w.writeString(e.message);
  }
  if (e.detailsJson !== '') {
    w.writeTag(3, 2);
    w.writeString(e.detailsJson);
  }
  return w.finish();
}

export function encodeWorkResponse(res: WorkResponseFields): Uint8Array {
  const w = new Writer();
  if (res.workId !== '') {
    w.writeTag(1, 2);
    w.writeString(res.workId);
  }
  if (res.status !== WorkResponseStatus.UNSPECIFIED) {
    w.writeTag(2, 0);
    w.writeVarint(res.status);
  }
  if (res.output.length !== 0) {
    w.writeTag(3, 2);
    w.writeBytes(res.output);
  }
  if (!operationErrorIsEmpty(res.error)) {
    w.writeTag(4, 2);
    w.writeBytes(encodeOperationError(res.error));
  }
  return w.finish();
}

export interface PartialResultFields {
  workId: string;
  unit: string;
  status: number;
  data: Uint8Array;
  error: OperationErrorFields;
  duration: DurationFields;
}

export function encodePartialResult(p: PartialResultFields): Uint8Array {
  const w = new Writer();
  if (p.workId !== '') {
    w.writeTag(1, 2);
    w.writeString(p.workId);
  }
  if (p.unit !== '') {
    w.writeTag(2, 2);
    w.writeString(p.unit);
  }
  if (p.status !== 0) {
    w.writeTag(3, 0);
    w.writeVarint(p.status);
  }
  if (p.data.length !== 0) {
    w.writeTag(4, 2);
    w.writeBytes(p.data);
  }
  if (!operationErrorIsEmpty(p.error)) {
    w.writeTag(5, 2);
    w.writeBytes(encodeOperationError(p.error));
  }
  if (p.duration.seconds !== 0 || p.duration.nanos !== 0) {
    w.writeTag(6, 2);
    w.writeBytes(encodeDuration(p.duration));
  }
  return w.finish();
}

class Reader {
  offset = 0;
  constructor(private readonly buf: Uint8Array) {}

  atEnd(): boolean {
    return this.offset >= this.buf.length;
  }

  readVarint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.offset >= this.buf.length) {
        throw new Error('truncated varint');
      }
      const byte = this.buf[this.offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new Error('varint too long');
    }
  }

  readVarintNumber(): number {
    return Number(this.readVarint());
  }

  readTag(): { fieldNumber: number; wireType: number } {
    const tag = this.readVarintNumber();
    return { fieldNumber: tag >>> 3, wireType: tag & 0x7 };
  }

  readBytes(): Uint8Array {
    const len = this.readVarintNumber();
    if (len < 0 || this.offset + len > this.buf.length) {
      throw new Error('truncated length-delimited field');
    }
    const out = this.buf.slice(this.offset, this.offset + len);
    this.offset += len;
    return out;
  }

  readString(): string {
    return TEXT_DECODER.decode(this.readBytes());
  }

  skip(wireType: number): void {
    if (wireType === 0) this.readVarint();
    else if (wireType === 2) this.readBytes();
    else if (wireType === 1) {
      if (this.offset + 8 > this.buf.length) {
        throw new Error('truncated length-delimited field');
      }
      this.offset += 8;
    } else if (wireType === 5) {
      if (this.offset + 4 > this.buf.length) {
        throw new Error('truncated length-delimited field');
      }
      this.offset += 4;
    } else throw new Error(`unsupported wire type ${wireType}`);
  }
}

function decodeOperationError(buf: Uint8Array): OperationErrorFields {
  const r = new Reader(buf);
  const out: OperationErrorFields = { code: '', message: '', detailsJson: '' };
  while (!r.atEnd()) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1 && wireType === 2) out.code = r.readString();
    else if (fieldNumber === 2 && wireType === 2) out.message = r.readString();
    else if (fieldNumber === 3 && wireType === 2) out.detailsJson = r.readString();
    else r.skip(wireType);
  }
  return out;
}

export function decodeWorkResponse(buf: Uint8Array): WorkResponseFields {
  const r = new Reader(buf);
  const out: WorkResponseFields = {
    workId: '',
    status: WorkResponseStatus.UNSPECIFIED,
    output: new Uint8Array(),
    error: { code: '', message: '', detailsJson: '' },
  };
  while (!r.atEnd()) {
    const { fieldNumber, wireType } = r.readTag();
    if (fieldNumber === 1 && wireType === 2) out.workId = r.readString();
    else if (fieldNumber === 2 && wireType === 0) out.status = r.readVarintNumber();
    else if (fieldNumber === 3 && wireType === 2) out.output = r.readBytes();
    else if (fieldNumber === 4 && wireType === 2) out.error = decodeOperationError(r.readBytes());
    else r.skip(wireType);
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`odd-length hex: ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(buf: Uint8Array): string {
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    out += buf[i].toString(16).padStart(2, '0');
  }
  return out;
}
