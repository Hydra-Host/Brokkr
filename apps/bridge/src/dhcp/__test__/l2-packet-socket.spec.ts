import { describe, expect, it } from 'vitest';

import {
  DHCP_BROADCAST_BPF,
  InMemoryPacketSocket,
  PacketSocketUnavailableError,
  tryCreateNativeSocket,
} from '../l2/packet-socket.js';

describe('InMemoryPacketSocket', () => {
  it('delivers injected frames to the registered handler', () => {
    const sock = new InMemoryPacketSocket();
    const received: Array<{ ifindex: number }> = [];
    sock.onFrame((frame) => received.push({ ifindex: frame.ifindex }));

    sock.inject({ ifindex: 3, srcMac: Buffer.alloc(6), frame: Buffer.alloc(64) });
    sock.inject({ ifindex: 7, srcMac: Buffer.alloc(6), frame: Buffer.alloc(64) });

    expect(received).toHaveLength(2);
    expect(received[0].ifindex).toBe(3);
    expect(received[1].ifindex).toBe(7);
  });

  it('records sent frames with ifindex and dstMac', () => {
    const sock = new InMemoryPacketSocket();
    const mac = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
    const frame = Buffer.from([1, 2, 3]);

    sock.send(5, mac, frame);

    expect(sock.sent).toHaveLength(1);
    expect(sock.sent[0].ifindex).toBe(5);
    expect(sock.sent[0].dstMac).toEqual(mac);
    expect(sock.sent[0].frame).toEqual(frame);
  });

  it('does not deliver frames after close', () => {
    const sock = new InMemoryPacketSocket();
    const received: unknown[] = [];
    sock.onFrame((frame) => received.push(frame));
    sock.close();

    sock.inject({ ifindex: 1, srcMac: Buffer.alloc(6), frame: Buffer.alloc(64) });
    expect(received).toHaveLength(0);
  });

  it('silently drops sends after close', () => {
    const sock = new InMemoryPacketSocket();
    sock.close();
    sock.send(1, Buffer.alloc(6), Buffer.alloc(10));
    expect(sock.sent).toHaveLength(0);
  });

  it('reports isNative as false', () => {
    expect(new InMemoryPacketSocket().isNative).toBe(false);
  });

  it('exposes ifindex and ifMac from constructor', () => {
    const mac = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
    const sock = new InMemoryPacketSocket(42, mac);
    expect(sock.ifindex).toBe(42);
    expect(sock.ifMac).toEqual(mac);
  });

  it('defaults ifindex to 0 and ifMac to all-zeros', () => {
    const sock = new InMemoryPacketSocket();
    expect(sock.ifindex).toBe(0);
    expect(sock.ifMac).toEqual(Buffer.alloc(6));
  });

  it('copies buffers on send to prevent mutation', () => {
    const sock = new InMemoryPacketSocket();
    const mac = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
    const frame = Buffer.from([1, 2, 3]);
    sock.send(1, mac, frame);

    mac[0] = 0x00;
    frame[0] = 0x99;

    expect(sock.sent[0].dstMac[0]).toBe(0xaa);
    expect(sock.sent[0].frame[0]).toBe(1);
  });
});

describe('NativePacketSocket graceful degradation', () => {
  it('returns a discriminated error (never throws) when a native socket cannot be created', () => {
    const result = tryCreateNativeSocket('brokkr-test-nonexistent0');

    expect(result.kind).not.toBe('ok');
    if (result.kind === 'addon-unavailable') {
      expect(result.reason).toBeTruthy();
    } else if (result.kind === 'nic-error') {
      expect(result.nicError).toBeTruthy();
    }
  });

  it('returns a non-ok result when the addon load fails', () => {
    const result = tryCreateNativeSocket('brokkr-test-nonexistent1');
    expect(result.kind).not.toBe('ok');
  });

  it('PacketSocketUnavailableError has the correct name', () => {
    const err = new PacketSocketUnavailableError('test reason');
    expect(err.name).toBe('PacketSocketUnavailableError');
    expect(err.message).toContain('test reason');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('DHCP_BROADCAST_BPF filter', () => {
  it('is a well-formed BPF program (array of 4-element quads)', () => {
    expect(Array.isArray(DHCP_BROADCAST_BPF)).toBe(true);
    expect(DHCP_BROADCAST_BPF.length).toBeGreaterThan(0);
    for (const instruction of DHCP_BROADCAST_BPF) {
      expect(instruction).toHaveLength(4);
      for (const val of instruction) {
        expect(typeof val).toBe('number');
      }
    }
  });

  it('has exactly one ACCEPT (return non-zero) and one REJECT (return 0) instruction', () => {
    const returns = DHCP_BROADCAST_BPF.filter((i) => i[0] === 0x06);
    expect(returns.length).toBe(2);
    const accept = returns.find((r) => r[3] > 0);
    const reject = returns.find((r) => r[3] === 0);
    expect(accept).toBeDefined();
    expect(reject).toBeDefined();
  });

  it('all conditional jump targets (jt/jf) stay within the program bounds', () => {
    const flen = DHCP_BROADCAST_BPF.length;
    for (let pc = 0; pc < flen; pc++) {
      const [code, jt, jf] = DHCP_BROADCAST_BPF[pc];
      const isConditionalJump = (code & 0xf0) === 0x10;
      if (!isConditionalJump) continue;
      expect(pc + 1 + jt).toBeLessThan(flen);
      expect(pc + 1 + jf).toBeLessThan(flen);
    }
  });
});
