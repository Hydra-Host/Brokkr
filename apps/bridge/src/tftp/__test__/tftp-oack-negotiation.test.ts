
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { decodePacket, encodeRrq, encodeWrq, type DecodedOack } from '../tftp-packet-types.js';
import { DEF_BLKSIZE, TftpException } from '../tftp-shared.js';
import {
  TftpStateServerRecvRRQ,
  TftpStateServerStart,
  type EncodedPacket,
  type TftpDgramSocket,
  type TftpStateContext,
  type TftpStateMetrics,
} from '../tftp-states.js';

const CLIENT_HOST = '127.0.0.1';
const CLIENT_PORT = 37412;
const TEST_FILE_SIZE = 11000;

interface CapturingSocket extends TftpDgramSocket {
  sends: Buffer[];
}

function makeSocket(): CapturingSocket {
  const sends: Buffer[] = [];
  return {
    sends,
    send(buffer: Buffer, _port: number, _host: string): void {
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
  if (last === undefined) {
    throw new Error('expected at least one send on the socket');
  }
  return last;
}

interface TftpFixture {
  root: string;
  sock: CapturingSocket;
  context: TftpStateContext;
  cleanup(): void;
}

function makeFixture(): TftpFixture {
  const root = mkdtempSync(join(tmpdir(), 'tftp-oack-test-'));
  writeFileSync(join(root, 'test.bin'), Buffer.alloc(TEST_FILE_SIZE, 'x'));
  const sock = makeSocket();
  const context = makeContext(root, sock);
  return {
    root,
    sock,
    context,
    cleanup(): void {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('OACK only echoes requested options', () => {
  let fixture: TftpFixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('returns tsize-only OACK when client asked for tsize only', () => {
    const rrq = decodePacket(encodeRrq('test.bin', 'octet', { tsize: '0' }));
    new TftpStateServerRecvRRQ(fixture.context).handle(rrq, CLIENT_HOST, CLIENT_PORT);
    const decoded = decodePacket(lastSent(fixture.sock)) as DecodedOack;
    expect(decoded.kind).toBe('OACK');
    expect(decoded.options).toEqual({ tsize: String(TEST_FILE_SIZE) });
  });

  it('returns blksize-only OACK when client asked for blksize only', () => {
    const rrq = decodePacket(encodeRrq('test.bin', 'octet', { blksize: '1456' }));
    new TftpStateServerRecvRRQ(fixture.context).handle(rrq, CLIENT_HOST, CLIENT_PORT);
    const decoded = decodePacket(lastSent(fixture.sock)) as DecodedOack;
    expect(decoded.kind).toBe('OACK');
    expect(decoded.options).toEqual({ blksize: '1456' });
  });

  it('returns both options when both are requested', () => {
    const rrq = decodePacket(encodeRrq('test.bin', 'octet', { tsize: '0', blksize: '1456' }));
    new TftpStateServerRecvRRQ(fixture.context).handle(rrq, CLIENT_HOST, CLIENT_PORT);
    const decoded = decodePacket(lastSent(fixture.sock)) as DecodedOack;
    expect(decoded.kind).toBe('OACK');
    expect(decoded.options).toEqual({ tsize: String(TEST_FILE_SIZE), blksize: '1456' });
  });

  it('skips OACK and begins streaming DATA when no options are requested', () => {
    const rrq = decodePacket(encodeRrq('test.bin', 'octet', {}));
    new TftpStateServerRecvRRQ(fixture.context).handle(rrq, CLIENT_HOST, CLIENT_PORT);
    const decoded = decodePacket(lastSent(fixture.sock));
    expect(decoded.kind).toBe('DAT');
  });
});

describe('OACK blksize negotiation clamps boundaries', () => {
  let fixture: TftpFixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('clamps blksize above maximum to MAX_BLKSIZE', () => {
    const rrq = decodePacket(encodeRrq('test.bin', 'octet', { blksize: '99999' }));
    new TftpStateServerRecvRRQ(fixture.context).handle(rrq, CLIENT_HOST, CLIENT_PORT);
    const decoded = decodePacket(lastSent(fixture.sock)) as DecodedOack;
    expect(decoded.options).toEqual({ blksize: '65536' });
  });

  it('clamps blksize below minimum to MIN_BLKSIZE', () => {
    const rrq = decodePacket(encodeRrq('test.bin', 'octet', { blksize: '1' }));
    new TftpStateServerRecvRRQ(fixture.context).handle(rrq, CLIENT_HOST, CLIENT_PORT);
    const decoded = decodePacket(lastSent(fixture.sock)) as DecodedOack;
    expect(decoded.options).toEqual({ blksize: '8' });
  });
});

describe('Read-only server rejects WRQ', () => {
  let fixture: TftpFixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  it('emits ERR-4 on the wire and aborts the session', () => {
    const wrq = decodePacket(encodeWrq('new-file.bin', 'octet', {}));
    const state = new TftpStateServerStart(fixture.context);
    expect(() => state.handle(wrq, CLIENT_HOST, CLIENT_PORT)).toThrow(TftpException);
    const decoded = decodePacket(lastSent(fixture.sock));
    expect(decoded.kind).toBe('ERR');
    if (decoded.kind === 'ERR') {
      expect(decoded.errorcode).toBe(4);
    }
  });
});
