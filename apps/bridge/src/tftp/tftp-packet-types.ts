import { TftpException, tftpassert } from './tftp-shared.js';

export class StructUnpackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'error';
  }
}

export class UnicodeDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnicodeDecodeError';
  }
}

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

export class TftpKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TftpKeyError';
  }
}

const ERR_MESSAGES: Record<number, Buffer> = {
  1: Buffer.from('File not found', 'ascii'),
  2: Buffer.from('Access violation', 'ascii'),
  3: Buffer.from('Disk full or allocation exceeded', 'ascii'),
  4: Buffer.from('Illegal TFTP operation', 'ascii'),
  5: Buffer.from('Unknown transfer ID', 'ascii'),
  6: Buffer.from('File already exists', 'ascii'),
  7: Buffer.from('No such user', 'ascii'),
  8: Buffer.from('Failed to negotiate options', 'ascii'),
};

function decodeAscii(buffer: Buffer): string {
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i]!;
    if (byte > 0x7f) {
      throw new UnicodeDecodeError(
        `'ascii' codec can't decode byte 0x${byte.toString(16).padStart(2, '0')} in position ${i}: ordinal not in range(128)`,
      );
    }
  }
  return buffer.toString('ascii');
}

export interface DecodedRrq {
  kind: 'RRQ';
  opcode: 1;
  filename: string;
  mode: string;
  options: Record<string, string>;
}

export interface DecodedWrq {
  kind: 'WRQ';
  opcode: 2;
  filename: string;
  mode: string;
  options: Record<string, string>;
}

export interface DecodedDat {
  kind: 'DAT';
  opcode: 3;
  blocknumber: number;
  data: Buffer;
}

export interface DecodedAck {
  kind: 'ACK';
  opcode: 4;
  blocknumber: number;
}

export interface DecodedErr {
  kind: 'ERR';
  opcode: 5;
  errorcode: number;
  errmsg: Buffer | null;
}

export interface DecodedOack {
  kind: 'OACK';
  opcode: 6;
  options: Record<string, string>;
}

export type DecodedPacket = DecodedRrq | DecodedWrq | DecodedDat | DecodedAck | DecodedErr | DecodedOack;

export function decodeOptionsBuffer(buffer: Buffer): Record<string, string> {
  if (buffer.length === 0) return {};

  const fragments: number[] = [];
  let length = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) {
      if (length > 0) {
        fragments.push(length);
        length = -1;
      } else {
        throw new TftpException('Invalid options in buffer');
      }
    }
    length += 1;
  }

  const expectedSize = fragments.reduce((acc, n) => acc + n + 1, 0);
  if (buffer.length !== expectedSize) {
    throw new StructUnpackError(`unpack requires a buffer of ${expectedSize} bytes`);
  }

  tftpassert(fragments.length % 2 === 0, 'packet with odd number of option/value pairs');

  const options: Record<string, string> = {};
  let offset = 0;
  const decoded: string[] = [];
  for (const n of fragments) {
    const slice = buffer.subarray(offset, offset + n);
    decoded.push(decodeAscii(slice));
    offset += n + 1;
  }
  for (let i = 0; i < decoded.length; i += 2) {
    options[decoded[i]!] = decoded[i + 1]!;
  }
  return options;
}

function encodeOptionsList(options: Record<string, string | number>): Buffer {
  const chunks: Buffer[] = [];
  for (const [rawKey, rawValue] of Object.entries(options)) {
    const key = Buffer.from(rawKey, 'ascii');
    const value =
      typeof rawValue === 'number' ? Buffer.from(String(rawValue), 'ascii') : Buffer.from(rawValue, 'ascii');
    chunks.push(key, Buffer.from([0]), value, Buffer.from([0]));
  }
  return Buffer.concat(chunks);
}

function encodeRequest(
  opcode: 1 | 2,
  filename: string,
  mode: string,
  options: Record<string, string | number>,
): Buffer {
  tftpassert(filename, 'filename required in initial packet');
  tftpassert(mode, 'mode required in initial packet');
  const modeBytes = Buffer.from(mode, 'ascii');
  if (mode !== 'octet') {
    throw new AssertionError(`Unsupported mode: b'${mode}'`);
  }
  const header = Buffer.alloc(2);
  header.writeUInt16BE(opcode, 0);
  const filenameBytes = Buffer.from(filename, 'ascii');
  const optionsBuf = encodeOptionsList(options);
  return Buffer.concat([header, filenameBytes, Buffer.from([0]), modeBytes, Buffer.from([0]), optionsBuf]);
}

export function encodeRrq(filename: string, mode: string, options: Record<string, string | number> = {}): Buffer {
  return encodeRequest(1, filename, mode, options);
}

export function encodeWrq(filename: string, mode: string, options: Record<string, string | number> = {}): Buffer {
  return encodeRequest(2, filename, mode, options);
}

export function encodeDat(blocknumber: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(3, 0);
  header.writeUInt16BE(blocknumber, 2);
  return Buffer.concat([header, data]);
}

export function encodeAck(blocknumber: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt16BE(4, 0);
  buffer.writeUInt16BE(blocknumber, 2);
  return buffer;
}

export function encodeErr(errorcode: number): Buffer {
  const message = ERR_MESSAGES[errorcode];
  if (message === undefined) {
    throw new TftpKeyError(String(errorcode));
  }
  const header = Buffer.alloc(4);
  header.writeUInt16BE(5, 0);
  header.writeUInt16BE(errorcode, 2);
  return Buffer.concat([header, message, Buffer.from([0])]);
}

export function encodeOack(options: Record<string, string | number>): Buffer {
  const header = Buffer.alloc(2);
  header.writeUInt16BE(6, 0);
  return Buffer.concat([header, encodeOptionsList(options)]);
}

function decodeInitial(opcode: 1 | 2, buffer: Buffer): DecodedRrq | DecodedWrq {
  const sub = buffer.subarray(2);
  let nulls = 0;
  let length = 0;
  let tlength = 0;
  const fragments: number[] = [];
  for (let i = 0; i < sub.length; i++) {
    if (sub[i] === 0) {
      nulls += 1;
      fragments.push(length);
      length = -1;
      if (nulls === 2) break;
    }
    length += 1;
    tlength += 1;
  }
  tftpassert(nulls === 2, 'malformed packet');
  const filenameBytes = sub.subarray(0, fragments[0]!);
  const modeStart = fragments[0]! + 1;
  const modeBytes = sub.subarray(modeStart, modeStart + fragments[1]!);
  const filename = decodeAscii(filenameBytes);
  const mode = decodeAscii(modeBytes).toLowerCase();
  const options = decodeOptionsBuffer(sub.subarray(tlength + 1));
  if (opcode === 1) {
    return { kind: 'RRQ', opcode: 1, filename, mode, options };
  }
  return { kind: 'WRQ', opcode: 2, filename, mode, options };
}

export function decodePacket(buffer: Buffer): DecodedPacket {
  if (buffer.length <= 2) {
    throw new TftpException('Invalid packet size');
  }
  const opcode = buffer.readUInt16BE(0);
  switch (opcode) {
    case 1:
    case 2:
      return decodeInitial(opcode, buffer);
    case 3: {
      const slice = buffer.subarray(2, 4);
      if (slice.length < 2) {
        throw new StructUnpackError('unpack requires a buffer of 2 bytes');
      }
      return {
        kind: 'DAT',
        opcode: 3,
        blocknumber: slice.readUInt16BE(0),
        data: Buffer.from(buffer.subarray(4)),
      };
    }
    case 4: {
      const slice = buffer.length > 4 ? buffer.subarray(0, 4) : buffer;
      if (slice.length < 4) {
        throw new StructUnpackError('unpack requires a buffer of 4 bytes');
      }
      return { kind: 'ACK', opcode: 4, blocknumber: slice.readUInt16BE(2) };
    }
    case 5: {
      tftpassert(buffer.length >= 4, 'malformed ERR packet, too short');
      const errorcode = buffer.readUInt16BE(2);
      if (buffer.length === 4) {
        return { kind: 'ERR', opcode: 5, errorcode, errmsg: null };
      }
      const errmsg = Buffer.from(buffer.subarray(4, buffer.length - 1));
      return { kind: 'ERR', opcode: 5, errorcode, errmsg };
    }
    case 6:
      return { kind: 'OACK', opcode: 6, options: decodeOptionsBuffer(buffer.subarray(2)) };
    default:
      throw new TftpException(`Unsupported opcode: ${opcode}`);
  }
}
