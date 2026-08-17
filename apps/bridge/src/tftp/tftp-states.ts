import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { posix as posixPath } from 'node:path';

import {
  encodeAck,
  encodeDat,
  encodeErr,
  encodeOack,
  type DecodedAck,
  type DecodedErr,
  type DecodedPacket,
  type DecodedRrq,
  type DecodedWrq,
} from './tftp-packet-types.js';
import {
  DEF_BLKSIZE,
  MAX_BLKSIZE,
  MIN_BLKSIZE,
  TftpErrors,
  TftpException,
  TftpFileNotFoundError,
  TftpTimeoutExpectACK,
} from './tftp-shared.js';

export class TftpValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

export class TftpAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

function strictInt(value: string | number): number {
  if (typeof value === 'number') {
    return Math.trunc(value);
  }
  const stripped = value.trim();
  if (stripped.length === 0 || !/^[+-]?\d+(_\d+)*$/.test(stripped)) {
    throw new TftpValueError(`invalid integer: ${JSON.stringify(value)}`);
  }
  return parseInt(stripped.replace(/_/g, ''), 10);
}

export function negotiateSupportedOptions(options: Record<string, string | number>): Record<string, string | number> {
  const accepted: Record<string, string | number> = {};
  for (const [option, value] of Object.entries(options)) {
    if (option === 'blksize') {
      const requested = strictInt(value);
      if (requested > MAX_BLKSIZE) {
        accepted['blksize'] = MAX_BLKSIZE;
      } else if (requested < MIN_BLKSIZE) {
        accepted['blksize'] = MIN_BLKSIZE;
      } else {
        accepted['blksize'] = value;
      }
    } else if (option === 'tsize') {
      accepted['tsize'] = 0;
    }
  }
  return accepted;
}

export type AckTransition = 'done' | 'advance' | 'dup' | 'error';

export function classifyAckTransition(ackBlock: number, nextBlock: number, pendingComplete: boolean): AckTransition {
  if (ackBlock === nextBlock) {
    return pendingComplete ? 'done' : 'advance';
  }
  if (ackBlock < nextBlock) {
    return 'dup';
  }
  return 'error';
}

// posix.normalize keeps a trailing slash that os.path.normpath strips — strip it so the `startsWith(normalized + sep)` jail check is correct; abspath === root must NOT count as inRoot.
export function resolveTftpPath(root: string, filename: string): { abspath: string; inRoot: boolean } {
  const fullPath = filename.startsWith(root) ? filename : posixPath.join(root, filename.replace(/^\/+/, ''));
  const abspath = posixPath.resolve(fullPath);
  let normalizedRoot = posixPath.normalize(root);
  if (normalizedRoot.length > 1 && normalizedRoot.endsWith(posixPath.sep)) {
    normalizedRoot = normalizedRoot.slice(0, -1);
  }
  const inRoot = abspath.startsWith(normalizedRoot + posixPath.sep);
  return { abspath, inRoot };
}

const NETWORK_UNRELIABILITY = 0;

export interface TftpFileObject {
  read(size: number): Buffer;
  seekEnd(): void;
  seekStart(): void;
  tell(): number;
  closed: boolean;
  close(): void;
}

class FdFileObject implements TftpFileObject {
  private offset = 0;
  private readonly size: number;
  private _closed = false;

  constructor(private readonly fd: number) {
    this.size = fstatSync(fd).size;
  }

  get closed(): boolean {
    return this._closed;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    closeSync(this.fd);
  }

  read(size: number): Buffer {
    const buf = Buffer.alloc(size);
    const n = readSync(this.fd, buf, 0, size, this.offset);
    this.offset += n;
    return buf.subarray(0, n);
  }

  seekEnd(): void {
    this.offset = this.size;
  }

  seekStart(): void {
    this.offset = 0;
  }

  tell(): number {
    return this.offset;
  }
}

export interface TftpDgramSocket {
  send(buffer: Buffer, port: number, host: string, callback?: (err: Error | null) => void): void;
}

export interface TftpStateMetrics {
  bytes: number;
  resentBytes: number;
  errors: number;
  lastDatTime: number;
  addDup(pkt: EncodedPacket): void;
}

export interface EncodedPacket {
  readonly kind: 'DAT' | 'ACK' | 'ERR' | 'OACK';
  readonly buffer: Buffer;
  readonly str: string;
  readonly blocknumber?: number;
  readonly errorcode?: number;
  readonly options?: Record<string, string | number>;
  readonly data?: Buffer;
}

export type DynFileFunc = (filename: string, raddress: string, rport: number) => TftpFileObject | null;

export type PacketHook = (pkt: DecodedPacket | EncodedPacket) => void;

export interface TftpStateContext {
  host: string;
  port: number;
  tidport: number | null;
  sock: TftpDgramSocket;
  root: string;
  options: Record<string, string | number>;
  requestedOptions: Set<string> | null;
  nextBlock: number;
  fileToTransfer: string | null;
  fileobj: TftpFileObject | null;
  dynFileFunc: DynFileFunc | null;
  lastPkt: EncodedPacket | null;
  packethook: PacketHook | null;
  metrics: TftpStateMetrics;
  timeout: number;
  pendingComplete: boolean;
  getBlocksize(): number;
}

function datStr(blocknumber: number, dataLen: number): string {
  let s = `DAT packet: block ${blocknumber}`;
  if (dataLen > 0) {
    s += `\n    data: ${dataLen} bytes`;
  }
  return s;
}

function ackStr(blocknumber: number): string {
  return `ACK packet: block ${blocknumber}`;
}

const ERR_MSG_STRINGS: Record<number, string> = {
  1: "b'File not found'",
  2: "b'Access violation'",
  3: "b'Disk full or allocation exceeded'",
  4: "b'Illegal TFTP operation'",
  5: "b'Unknown transfer ID'",
  6: "b'File already exists'",
  7: "b'No such user'",
  8: "b'Failed to negotiate options'",
};

function errStr(errorcode: number): string {
  const msg = ERR_MSG_STRINGS[errorcode] ?? '';
  return `ERR packet: errorcode = ${errorcode}\n    msg = ${msg}`;
}

function oackStr(options: Record<string, string | number>): string {
  return `OACK packet:\n    options = ${dictStr(options)}`;
}

function dictStr(d: Record<string, string | number>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    const valStr = typeof v === 'string' ? JSON.stringify(v) : String(v);
    parts.push(`${JSON.stringify(k)}: ${valStr}`);
  }
  return `{${parts.join(', ')}}`;
}

export abstract class TftpState {
  constructor(public readonly context: TftpStateContext) {}

  abstract handle(pkt: DecodedPacket, raddress: string, rport: number): TftpState | null;

  returnSupportedOptions(options: Record<string, string | number>): Record<string, string | number> {
    return negotiateSupportedOptions(options);
  }

  sendDAT(): boolean {
    let finished = false;
    const blocknumber = this.context.nextBlock;
    const blksize = this.context.getBlocksize();
    const fileobj = this.context.fileobj;
    if (fileobj === null) {
      throw new TftpException('fileobj not initialized');
    }
    const data = fileobj.read(blksize);
    if (data.length < blksize) {
      finished = true;
    }
    this.context.metrics.bytes += data.length;
    const encoded = encodeDat(blocknumber, data);
    const packet: EncodedPacket = {
      kind: 'DAT',
      buffer: encoded,
      str: datStr(blocknumber, data.length),
      blocknumber,
      data,
    };
    const dropToSimulateUnreliability =
      NETWORK_UNRELIABILITY > 0 && Math.floor(Math.random() * NETWORK_UNRELIABILITY) === 0;
    if (!dropToSimulateUnreliability) {
      this.sendBuffer(encoded);
      this.context.metrics.lastDatTime = Date.now() / 1000;
    }
    if (this.context.packethook) {
      this.context.packethook(packet);
    }
    this.context.lastPkt = packet;
    return finished;
  }

  sendACK(blocknumber?: number): void {
    const block = blocknumber ?? this.context.nextBlock;
    const encoded = encodeAck(block);
    const packet: EncodedPacket = {
      kind: 'ACK',
      buffer: encoded,
      str: ackStr(block),
      blocknumber: block,
    };
    const dropToSimulateUnreliability =
      NETWORK_UNRELIABILITY > 0 && Math.floor(Math.random() * NETWORK_UNRELIABILITY) === 0;
    if (!dropToSimulateUnreliability) {
      this.sendBuffer(encoded);
    }
    this.context.lastPkt = packet;
  }

  sendError(errorcode: number): void {
    const encoded = encodeErr(errorcode);
    const packet: EncodedPacket = {
      kind: 'ERR',
      buffer: encoded,
      str: errStr(errorcode),
      errorcode,
    };
    if (this.context.tidport !== null) {
      this.sendBuffer(encoded);
    }
    this.context.lastPkt = packet;
  }

  sendOACK(): void {
    const requested = this.context.requestedOptions;
    let toEmit: Record<string, string | number>;
    if (requested === null) {
      toEmit = this.context.options;
    } else {
      toEmit = {};
      for (const [k, v] of Object.entries(this.context.options)) {
        if (requested.has(k)) {
          toEmit[k] = v;
        }
      }
    }
    const encoded = encodeOack(toEmit);
    const packet: EncodedPacket = {
      kind: 'OACK',
      buffer: encoded,
      str: oackStr(toEmit),
      options: toEmit,
    };
    this.sendBuffer(encoded);
    this.context.lastPkt = packet;
  }

  resendLast(): void {
    const last = this.context.lastPkt;
    if (last === null) {
      throw new TftpAssertionError('');
    }
    this.context.metrics.resentBytes += last.buffer.length;
    this.context.metrics.addDup(last);
    const sendtoPort = this.context.tidport || this.context.port;
    this.context.sock.send(last.buffer, sendtoPort, this.context.host);
    if (this.context.packethook) {
      this.context.packethook(last);
    }
  }

  protected sendBuffer(buffer: Buffer): void {
    const port = this.context.tidport;
    if (port === null) {
      throw new TftpException('tidport not set');
    }
    this.context.sock.send(buffer, port, this.context.host);
  }
}

export abstract class TftpServerState extends TftpState {
  fullPath: string | null = null;

  // Upstream tftpy bug parity: UnknownTID must throw TypeError (not TftpException) so the runLoop crash surfaces.
  serverInitial(pkt: DecodedRrq | DecodedWrq, raddress: string, rport: number): boolean {
    const options = pkt.options;
    let sendoack = false;
    if (!this.context.tidport) {
      this.context.tidport = rport;
    }

    this.context.options = { blksize: DEF_BLKSIZE };
    this.context.requestedOptions = new Set();

    if (options && Object.keys(options).length > 0) {
      const supported = this.returnSupportedOptions(options);
      Object.assign(this.context.options, supported);
      this.context.requestedOptions = new Set(Object.keys(supported));
      sendoack = true;
    }

    if (this.context.host !== raddress || this.context.port !== rport) {
      this.sendError(TftpErrors.UnknownTID);
      throw new TypeError('TFTP request source address mismatch: expected known transfer peer, got unknown TID');
    }

    const resolved = resolveTftpPath(this.context.root, pkt.filename);
    this.fullPath = resolved.abspath;
    if (!resolved.inRoot) {
      this.sendError(TftpErrors.IllegalTftpOp);
      throw new TftpException('bad file path');
    }

    this.context.fileToTransfer = pkt.filename;

    return sendoack;
  }
}

export class TftpStateServerRecvRRQ extends TftpServerState {
  handle(pkt: DecodedPacket, raddress: string, rport: number): TftpState | null {
    if (pkt.kind !== 'RRQ') {
      throw new TftpException(`Expected RRQ, got ${pkt.kind}`);
    }
    const sendoack = this.serverInitial(pkt, raddress, rport);
    const path = this.fullPath;
    if (path === null) {
      throw new TftpException('fullPath not set');
    }

    if (existsSync(path)) {
      this.context.fileobj = new FdFileObject(openSync(path, 'r'));
    } else if (this.context.dynFileFunc) {
      this.context.fileobj = this.context.dynFileFunc(this.context.fileToTransfer ?? '', raddress, rport);
      if (this.context.fileobj === null) {
        this.sendError(TftpErrors.FileNotFound);
        throw new TftpFileNotFoundError(`File not found: ${path}`);
      }
    } else {
      this.sendError(TftpErrors.FileNotFound);
      throw new TftpFileNotFoundError(`File not found: ${path}`);
    }

    if (sendoack && 'tsize' in this.context.options) {
      this.context.fileobj.seekEnd();
      const tsize = String(this.context.fileobj.tell());
      this.context.fileobj.seekStart();
      this.context.options['tsize'] = tsize;
    }

    if (sendoack) {
      this.sendOACK();
    } else {
      this.context.nextBlock = 1;
      this.context.pendingComplete = this.sendDAT();
    }
    return new TftpStateExpectACK(this.context);
  }
}

export class TftpStateServerStart extends TftpState {
  handle(pkt: DecodedPacket, raddress: string, rport: number): TftpState | null {
    if (pkt.kind === 'RRQ') {
      return new TftpStateServerRecvRRQ(this.context).handle(pkt, raddress, rport);
    }
    if (!this.context.tidport) {
      this.context.tidport = rport;
    }
    if (pkt.kind === 'WRQ') {
      this.sendError(TftpErrors.IllegalTftpOp);
      throw new TftpException('WRQ rejected: bridge TFTP is read-only');
    }
    this.sendError(TftpErrors.IllegalTftpOp);
    throw new TftpException(`Invalid packet to begin download: ${pkt.kind}`);
  }
}

export class TftpStateExpectACK extends TftpState {
  handle(pkt: DecodedPacket, _raddress: string, _rport: number): TftpState | null {
    if (pkt.kind === 'ACK') {
      const ack: DecodedAck = pkt;
      const action = classifyAckTransition(ack.blocknumber, this.context.nextBlock, this.context.pendingComplete);
      if (action === 'done') {
        return null;
      }
      if (action === 'advance') {
        this.context.nextBlock += 1;
        this.context.pendingComplete = this.sendDAT();
      } else if (action === 'dup') {
        this.context.metrics.addDup(dupKeyForAck(ack));
        if (this.context.metrics.lastDatTime > 0) {
          if (Date.now() / 1000 - this.context.metrics.lastDatTime > this.context.timeout) {
            throw new TftpTimeoutExpectACK(`Timeout waiting for ACK for block ${this.context.nextBlock}`);
          }
        }
      } else {
        this.context.metrics.errors += 1;
      }
      return this;
    }
    if (pkt.kind === 'ERR') {
      const err: DecodedErr = pkt;
      throw new TftpException(`Received ERR packet from peer: ${errStrFromDecoded(err)}`);
    }
    return this;
  }
}

function dupKeyForAck(pkt: DecodedAck): EncodedPacket {
  return {
    kind: 'ACK',
    buffer: encodeAck(pkt.blocknumber),
    str: ackStr(pkt.blocknumber),
    blocknumber: pkt.blocknumber,
  };
}

function errStrFromDecoded(pkt: DecodedErr): string {
  const msg = ERR_MSG_STRINGS[pkt.errorcode] ?? '';
  return `ERR packet: errorcode = ${pkt.errorcode}\n    msg = ${msg}`;
}
