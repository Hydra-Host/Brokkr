import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { decodePacket, encodeRrq, type DecodedErr } from '../tftp-packet-types.js';
import { DEF_BLKSIZE, TftpErrors, TftpException, TftpFileNotFoundError } from '../tftp-shared.js';
import {
  TftpStateServerRecvRRQ,
  type EncodedPacket,
  type TftpDgramSocket,
  type TftpStateContext,
  type TftpStateMetrics,
} from '../tftp-states.js';

const CLIENT_HOST = '127.0.0.1';
const CLIENT_PORT = 37412;

interface CapturingSocket extends TftpDgramSocket {
  sends: Buffer[];
}

function makeSocket(): CapturingSocket {
  const sends: Buffer[] = [];
  return {
    sends,
    send(buffer: Buffer): void {
      sends.push(Buffer.from(buffer));
    },
  };
}

function makeMetrics(): TftpStateMetrics {
  return {
    bytes: 0,
    resentBytes: 0,
    errors: 0,
    lastDatTime: 0,
    addDup: (_pkt: EncodedPacket): void => {},
  };
}

function makeContext(root: string, sock: CapturingSocket): TftpStateContext {
  return {
    host: CLIENT_HOST,
    port: CLIENT_PORT,
    tidport: null,
    sock,
    root,
    options: {},
    requestedOptions: null,
    nextBlock: 0,
    fileToTransfer: null,
    fileobj: null,
    dynFileFunc: null,
    lastPkt: null,
    packethook: null,
    metrics: makeMetrics(),
    timeout: 5,
    pendingComplete: false,
    getBlocksize(): number {
      const raw = this.options['blksize'];
      if (raw === undefined) return DEF_BLKSIZE;
      return typeof raw === 'number' ? raw : parseInt(String(raw), 10);
    },
  };
}

function lastSent(sock: CapturingSocket): Buffer {
  const last = sock.sends[sock.sends.length - 1];
  if (last === undefined) throw new Error('expected at least one send on the socket');
  return last;
}

describe('TftpStateServerRecvRRQ file-not-found', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tftp-not-found-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('throws TftpFileNotFoundError when no file and no dynFileFunc', () => {
    const sock = makeSocket();
    const context = makeContext(root, sock);
    const rrq = decodePacket(encodeRrq('missing.bin', 'octet', {}));
    const state = new TftpStateServerRecvRRQ(context);

    expect(() => state.handle(rrq, CLIENT_HOST, CLIENT_PORT)).toThrow(TftpFileNotFoundError);
    try {
      state.handle(rrq, CLIENT_HOST, CLIENT_PORT);
    } catch (err) {
      expect(err).toBeInstanceOf(TftpException);
    }
    const decoded = decodePacket(lastSent(sock)) as DecodedErr;
    expect(decoded.kind).toBe('ERR');
    expect(decoded.errorcode).toBe(TftpErrors.FileNotFound);
  });

  it('throws TftpFileNotFoundError when dynFileFunc returns null', () => {
    const sock = makeSocket();
    const context = makeContext(root, sock);
    context.dynFileFunc = () => null;
    const rrq = decodePacket(encodeRrq('missing.bin', 'octet', {}));
    const state = new TftpStateServerRecvRRQ(context);

    expect(() => state.handle(rrq, CLIENT_HOST, CLIENT_PORT)).toThrow(TftpFileNotFoundError);
    const decoded = decodePacket(lastSent(sock)) as DecodedErr;
    expect(decoded.kind).toBe('ERR');
    expect(decoded.errorcode).toBe(TftpErrors.FileNotFound);
  });
});
