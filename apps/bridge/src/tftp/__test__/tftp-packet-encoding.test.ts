import { describe, expect, it } from 'vitest';

import {
  decodePacket,
  encodeAck,
  encodeDat,
  encodeErr,
  encodeOack,
  encodeRrq,
  encodeWrq,
  type DecodedAck,
  type DecodedDat,
  type DecodedErr,
  type DecodedOack,
  type DecodedRrq,
  type DecodedWrq,
} from '../tftp-packet-types.js';
import { TftpException } from '../tftp-shared.js';

describe('TftpPacketRRQ', () => {
  it('encodes and decodes a RRQ without options', () => {
    const buffer = encodeRrq('myfilename', 'octet', {});
    const decoded = decodePacket(buffer) as DecodedRrq;
    expect(decoded.kind).toBe('RRQ');
    expect(decoded.opcode).toBe(1);
    expect(decoded.filename).toBe('myfilename');
    expect(decoded.mode).toBe('octet');
    expect(decoded.options).toEqual({});
  });

  it('encodes and decodes a RRQ with blksize option', () => {
    const buffer = encodeRrq('myfilename', 'octet', { blksize: '1024' });
    const decoded = decodePacket(buffer) as DecodedRrq;
    expect(decoded.filename).toBe('myfilename');
    expect(decoded.mode).toBe('octet');
    expect(decoded.options['blksize']).toBe('1024');
  });
});

describe('TftpPacketWRQ', () => {
  it('encodes and decodes a WRQ without options', () => {
    const buffer = encodeWrq('myfilename', 'octet', {});
    const decoded = decodePacket(buffer) as DecodedWrq;
    expect(decoded.kind).toBe('WRQ');
    expect(decoded.opcode).toBe(2);
    expect(decoded.filename).toBe('myfilename');
    expect(decoded.mode).toBe('octet');
    expect(decoded.options).toEqual({});
  });

  it('encodes and decodes a WRQ with blksize option', () => {
    const buffer = encodeWrq('myfilename', 'octet', { blksize: '1024' });
    const decoded = decodePacket(buffer) as DecodedWrq;
    expect(decoded.opcode).toBe(2);
    expect(decoded.filename).toBe('myfilename');
    expect(decoded.mode).toBe('octet');
    expect(decoded.options['blksize']).toBe('1024');
  });
});

describe('TftpPacketDAT', () => {
  it('round-trips DAT bytes', () => {
    const data = Buffer.from('this is some data', 'ascii');
    const buffer = encodeDat(5, data);
    const decoded = decodePacket(buffer) as DecodedDat;
    expect(decoded.kind).toBe('DAT');
    expect(decoded.opcode).toBe(3);
    expect(decoded.blocknumber).toBe(5);
    expect(decoded.data.equals(data)).toBe(true);
  });
});

describe('TftpPacketACK', () => {
  it('round-trips ACK block number', () => {
    const buffer = encodeAck(6);
    const decoded = decodePacket(buffer) as DecodedAck;
    expect(decoded.kind).toBe('ACK');
    expect(decoded.opcode).toBe(4);
    expect(decoded.blocknumber).toBe(6);
  });
});

describe('TftpPacketERR', () => {
  it('round-trips ERR errorcode', () => {
    const buffer = encodeErr(4);
    const decoded = decodePacket(buffer) as DecodedErr;
    expect(decoded.kind).toBe('ERR');
    expect(decoded.opcode).toBe(5);
    expect(decoded.errorcode).toBe(4);
  });
});

describe('TftpPacketOACK', () => {
  it('coerces int blksize value to string on round-trip', () => {
    const buffer = encodeOack({ blksize: 2048 });
    const decoded = decodePacket(buffer) as DecodedOack;
    expect(decoded.kind).toBe('OACK');
    expect(decoded.opcode).toBe(6);
    expect(decoded.options['blksize']).toBe('2048');
  });

  it('round-trips string blksize value', () => {
    const buffer = encodeOack({ blksize: '4096' });
    const decoded = decodePacket(buffer) as DecodedOack;
    expect(decoded.options['blksize']).toBe('4096');
  });
});

describe('TftpPacketFactory', () => {
  const opcodeToKind: ReadonlyArray<[number, string, Buffer]> = [
    [1, 'RRQ', encodeRrq('f', 'octet', {})],
    [2, 'WRQ', encodeWrq('f', 'octet', {})],
    [3, 'DAT', encodeDat(1, Buffer.from('x', 'ascii'))],
    [4, 'ACK', encodeAck(0)],
    [5, 'ERR', encodeErr(4)],
    [6, 'OACK', encodeOack({ blksize: '512' })],
  ];

  for (const [opcode, kind, buffer] of opcodeToKind) {
    it(`dispatches opcode ${opcode} to ${kind}`, () => {
      const decoded = decodePacket(buffer);
      expect(decoded.opcode).toBe(opcode);
      expect(decoded.kind).toBe(kind);
    });
  }

  it('parses a minimal valid ACK buffer (opcode 4, block 0)', () => {
    const decoded = decodePacket(Buffer.from('00040000', 'hex')) as DecodedAck;
    expect(decoded.opcode).toBe(4);
    expect(decoded.blocknumber).toBe(0);
  });

  it('rejects an undersized buffer', () => {
    expect(() => decodePacket(Buffer.from('0004', 'hex'))).toThrow(new TftpException('Invalid packet size'));
  });
});
