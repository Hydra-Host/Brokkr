import { createSocket, type Socket as DgramSocket, type RemoteInfo } from 'node:dgram';
import { isIP } from 'node:net';

import { decodePacket, type DecodedPacket } from './tftp-packet-types.js';
import { DEF_TIMEOUT_RETRIES, MAX_DUPS, TftpTimeout, tftpassert } from './tftp-shared.js';

function dictRepr(options: Record<string, string>): string {
  const entries = Object.entries(options).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  return `{${entries.join(', ')}}`;
}

export function packetToString(pkt: DecodedPacket): string {
  switch (pkt.kind) {
    case 'RRQ': {
      let s = `RRQ packet: filename = ${pkt.filename} mode = ${pkt.mode}`;
      if (Object.keys(pkt.options).length > 0) {
        s += `\n    options = ${dictRepr(pkt.options)}`;
      }
      return s;
    }
    case 'WRQ': {
      let s = `WRQ packet: filename = ${pkt.filename} mode = ${pkt.mode}`;
      if (Object.keys(pkt.options).length > 0) {
        s += `\n    options = ${dictRepr(pkt.options)}`;
      }
      return s;
    }
    case 'DAT': {
      let s = `DAT packet: block ${pkt.blocknumber}`;
      if (pkt.data.length > 0) {
        s += `\n    data: ${pkt.data.length} bytes`;
      }
      return s;
    }
    case 'ACK':
      return `ACK packet: block ${pkt.blocknumber}`;
    case 'ERR': {
      const known = ERR_MSGS[pkt.errorcode];
      const msg = known === undefined ? '' : `b'${known}'`;
      return `ERR packet: errorcode = ${pkt.errorcode}\n    msg = ${msg}`;
    }
    case 'OACK':
      return `OACK packet:\n    options = ${dictRepr(pkt.options)}`;
  }
}

const ERR_MSGS: Record<number, string> = {
  1: 'File not found',
  2: 'Access violation',
  3: 'Disk full or allocation exceeded',
  4: 'Illegal TFTP operation',
  5: 'Unknown transfer ID',
  6: 'File already exists',
  7: 'No such user',
  8: 'Failed to negotiate options',
};

export type TftpFileLike = {
  closed: boolean;
  close(): void;
  unlock?(): void;
};

export type PacketHook = (pkt: DecodedPacket) => void;

export interface TftpStateLike {
  handle(pkt: DecodedPacket, raddress: string, rport: number): TftpStateLike | null;
}

export type TftpServerStartStateFactory = (context: TftpContextServer) => TftpStateLike;

export interface PacketFactoryLike {
  parse(buffer: Buffer): DecodedPacket;
}

interface PendingPacket {
  buffer: Buffer;
  raddress: string;
  rport: number;
}

export class TftpMetrics {
  bytes = 0;
  resentBytes = 0;
  dups: Record<string, number> = {};
  dupcount = 0;
  startTime = 0;
  endTime = 0;
  duration = 0;
  lastDatTime = 0;
  bps = 0;
  kbps = 0;
  errors = 0;

  compute(): void {
    this.duration = this.endTime - this.startTime;
    if (this.duration === 0) {
      this.duration = 1;
    }
    this.bps = (this.bytes * 8.0) / this.duration;
    this.kbps = this.bps / 1024.0;
    for (const key of Object.keys(this.dups)) {
      this.dupcount += this.dups[key]!;
    }
  }

  addDup(pkt: DecodedPacket): void {
    const s = packetToString(pkt);
    if (s in this.dups) {
      this.dups[s] = this.dups[s]! + 1;
    } else {
      this.dups[s] = 1;
    }
    tftpassert(this.dups[s]! < MAX_DUPS, 'Max duplicates reached');
  }
}

export interface TftpContextOptions {
  localip?: string;
  retries?: number;
  flock?: boolean;
}

export class TftpContext {
  fileToTransfer: string | null = null;
  fileobj: TftpFileLike | null = null;
  options: Record<string, string | number> | null = null;
  packethook: PacketHook | null = null;
  readonly sock: DgramSocket;
  readonly timeout: number;
  readonly retries: number;
  readonly flock: boolean;
  state: TftpStateLike | null = null;
  readonly factory: PacketFactoryLike = { parse: (buffer: Buffer) => decodePacket(buffer) };
  port: number;
  tidport: number | null = null;
  readonly metrics: TftpMetrics = new TftpMetrics();
  pendingComplete = false;
  lastUpdate = 0;
  lastPkt: DecodedPacket | null = null;
  retryCount = 0;
  timeoutExpectACK = false;

  private hostValue!: string;
  address!: string;
  private nextBlockValue = 0;
  private pendingPackets: PendingPacket[] = [];

  constructor(host: string, port: number, timeout: number, options: TftpContextOptions = {}) {
    const { localip = '', retries = DEF_TIMEOUT_RETRIES, flock = true } = options;
    this.sock = createSocket('udp4');
    if (localip !== '') {
      this.sock.bind(0, localip);
    }
    this.timeout = timeout;
    this.retries = retries;
    this.flock = flock;
    this.host = host;
    this.port = port;
  }

  get host(): string {
    return this.hostValue;
  }

  set host(value: string) {
    this.hostValue = value;
    this.address = resolveHostSync(value);
  }

  get nextBlock(): number {
    return this.nextBlockValue;
  }

  set nextBlock(block: number) {
    if (block >= 2 ** 16) {
      this.nextBlockValue = 0;
      return;
    }
    this.nextBlockValue = block;
  }

  getBlocksize(): number {
    if (this.options === null) {
      throw new TypeError("Cannot read properties of null (reading 'blksize')");
    }
    const raw = this.options['blksize'];
    if (raw === undefined) return 512;
    return typeof raw === 'number' ? Math.trunc(raw) : parseInt(String(raw), 10);
  }

  checkTimeout(now: number): void {
    if (this.timeoutExpectACK) {
      throw new TftpTimeout('Timeout waiting for traffic');
    }
    if (now - this.lastUpdate > this.timeout) {
      throw new TftpTimeout('Timeout waiting for traffic');
    }
  }

  start(..._args: unknown[]): void {
    throw new Error('Abstract method');
  }

  end(closeFileobj = true): void {
    this.sock.close();
    if (closeFileobj && this.fileobj !== null && !this.fileobj.closed) {
      if (this.flock && this.fileobj.unlock !== undefined) {
        this.fileobj.unlock();
      }
      this.fileobj.close();
    }
  }

  deliver(buffer: Buffer, raddress: string, rport: number): void {
    this.pendingPackets.push({ buffer, raddress, rport });
  }

  deliverFromRemote(buffer: Buffer, rinfo: RemoteInfo): void {
    this.deliver(buffer, rinfo.address, rinfo.port);
  }

  cycle(): void {
    const packet = this.pendingPackets.shift();
    if (packet === undefined) {
      throw new TftpTimeout('Timed-out waiting for traffic');
    }
    this.lastUpdate = nowSeconds();
    const recvpkt = this.factory.parse(packet.buffer);

    if (this.packethook) {
      this.packethook(recvpkt);
    }

    this.state = this.state!.handle(recvpkt, packet.raddress, packet.rport);
    this.retryCount = 0;
  }
}

export interface TftpContextServerOptions {
  retries?: number;
  flock?: boolean;
}

export class TftpContextServer extends TftpContext {
  readonly root: string;
  readonly dynFileFunc: ((filename: string) => unknown) | null;

  constructor(
    host: string,
    port: number,
    timeout: number,
    root: string,
    startStateFactory: TftpServerStartStateFactory,
    dynFileFunc: ((filename: string) => unknown) | null = null,
    options: TftpContextServerOptions = {},
  ) {
    const { retries = DEF_TIMEOUT_RETRIES, flock = true } = options;
    super(host, port, timeout, { retries, flock });
    this.root = root;
    this.dynFileFunc = dynFileFunc;
    this.state = startStateFactory(this);
  }

  toString(): string {
    return `${this.host}:${this.port} ${String(this.state)}`;
  }

  override start(buffer: Buffer): void {
    this.metrics.startTime = nowSeconds();
    this.lastUpdate = nowSeconds();
    const pkt = this.factory.parse(buffer);
    this.state = this.state!.handle(pkt, this.host, this.port);
  }

  override end(): void {
    super.end();
    this.metrics.endTime = nowSeconds();
    this.metrics.compute();
  }
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

function resolveHostSync(host: string): string {
  if (isIP(host) !== 0) {
    return host;
  }
  throw new Error(`TftpContext requires an IP address for host, received: ${host}`);
}
