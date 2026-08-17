
import { describe, expect, it } from 'vitest';

import { MAX_TCP_MESSAGE_BYTES, deframe, frameMessage } from '../tcp-framing.js';

function manualFrame(payload: Buffer): Buffer {
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(payload.length, 0);
  return Buffer.concat([prefix, payload]);
}

describe('frameMessage', () => {
  it('1: round-trips a payload through frame + deframe', () => {
    const payload = Buffer.from('hello dns');
    const framed = frameMessage(payload);
    expect(framed.readUInt16BE(0)).toBe(payload.length);
    expect(framed.subarray(2).equals(payload)).toBe(true);

    const { messages, remainder } = deframe(framed);
    expect(messages).toHaveLength(1);
    expect(messages[0].equals(payload)).toBe(true);
    expect(remainder).toHaveLength(0);
  });

  it('2: throws RangeError for a payload larger than 65535 bytes', () => {
    const tooBig = Buffer.alloc(MAX_TCP_MESSAGE_BYTES + 1);
    expect(() => frameMessage(tooBig)).toThrow(RangeError);
  });
});

describe('deframe', () => {
  it('3: returns no message and keeps the whole input when fewer than 2 bytes', () => {
    const input = Buffer.from([0x00]);
    const { messages, remainder } = deframe(input);
    expect(messages).toHaveLength(0);
    expect(remainder.equals(input)).toBe(true);
  });

  it('4: a prefix with zero body bytes available is buffered as remainder', () => {
    const input = Buffer.from([0x00, 0x05]);
    const { messages, remainder } = deframe(input);
    expect(messages).toHaveLength(0);
    expect(remainder.equals(input)).toBe(true);
  });

  it('5: a prefix with a partial body keeps the whole input as remainder', () => {
    const input = Buffer.concat([Buffer.from([0x00, 0x04]), Buffer.from([0xaa, 0xbb])]);
    const { messages, remainder } = deframe(input);
    expect(messages).toHaveLength(0);
    expect(remainder.equals(input)).toBe(true);
  });

  it('6: extracts a single complete frame with the length prefix stripped', () => {
    const payload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const { messages, remainder } = deframe(manualFrame(payload));
    expect(messages).toHaveLength(1);
    expect(messages[0].equals(payload)).toBe(true);
    expect(remainder).toHaveLength(0);
  });

  it('7: extracts two concatenated frames in order', () => {
    const a = Buffer.from('first');
    const b = Buffer.from('second-message');
    const { messages, remainder } = deframe(Buffer.concat([manualFrame(a), manualFrame(b)]));
    expect(messages).toHaveLength(2);
    expect(messages[0].equals(a)).toBe(true);
    expect(messages[1].equals(b)).toBe(true);
    expect(remainder).toHaveLength(0);
  });

  it('8: returns a complete frame and keeps the trailing partial as remainder', () => {
    const complete = Buffer.from('done');
    const partial = Buffer.concat([Buffer.from([0x00, 0x09]), Buffer.from('abc')]);
    const { messages, remainder } = deframe(Buffer.concat([manualFrame(complete), partial]));
    expect(messages).toHaveLength(1);
    expect(messages[0].equals(complete)).toBe(true);
    expect(remainder.equals(partial)).toBe(true);
  });

  it('9: a declared length of 0 emits an empty (malformed) message', () => {
    const { messages, remainder } = deframe(Buffer.from([0x00, 0x00]));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toHaveLength(0);
    expect(remainder).toHaveLength(0);
  });

  it('10: reassembles a frame split across 3 arbitrary chunk boundaries', () => {
    const payload = Buffer.from('reassembly across chunks');
    const framed = manualFrame(payload);
    const cuts = [1, 4, framed.length - 2];
    const chunks = [
      framed.subarray(0, cuts[0]),
      framed.subarray(cuts[0], cuts[1]),
      framed.subarray(cuts[1], cuts[2]),
      framed.subarray(cuts[2]),
    ];

    let accumulator = Buffer.alloc(0);
    const collected: Buffer[] = [];
    for (const chunk of chunks) {
      accumulator = Buffer.concat([accumulator, chunk]);
      const { messages, remainder } = deframe(accumulator);
      collected.push(...messages);
      accumulator = Buffer.from(remainder);
    }

    expect(collected).toHaveLength(1);
    expect(collected[0].equals(payload)).toBe(true);
    expect(accumulator).toHaveLength(0);
  });

  it('11: a complete frame followed by a stray byte leaves the stray as remainder', () => {
    const payload = Buffer.from('xyz');
    const stray = Buffer.from([0x42]);
    const { messages, remainder } = deframe(Buffer.concat([manualFrame(payload), stray]));
    expect(messages).toHaveLength(1);
    expect(messages[0].equals(payload)).toBe(true);
    expect(remainder.equals(stray)).toBe(true);
  });
});
