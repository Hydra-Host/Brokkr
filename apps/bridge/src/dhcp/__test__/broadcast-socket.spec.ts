import * as dgram from 'node:dgram';

import { describe, expect, it, vi } from 'vitest';

import {
  DHCP_CLIENT_PORT,
  DHCP_SERVER_PORT,
  LIMITED_BROADCAST,
  chooseNakTarget,
  chooseReplyTarget,
  sendReply,
} from '../broadcast-socket.js';
import type { DhcpMessage } from '../protocol.js';

function message(overrides: Partial<DhcpMessage> = {}): DhcpMessage {
  return {
    op: 1,
    htype: 1,
    hlen: 6,
    hops: 0,
    xid: 1,
    secs: 0,
    flags: 0,
    broadcast: false,
    ciaddr: '0.0.0.0',
    yiaddr: '0.0.0.0',
    siaddr: '0.0.0.0',
    giaddr: '0.0.0.0',
    chaddr: '00:0b:82:01:fc:42',
    messageType: 1,
    options: new Map(),
    ...overrides,
  };
}

describe('chooseReplyTarget', () => {
  it('unicasts to the relay on the server port when giaddr is set', () => {
    const target = chooseReplyTarget(message({ giaddr: '10.0.0.254' }));
    expect(target).toEqual({ address: '10.0.0.254', port: DHCP_SERVER_PORT });
  });

  it('falls back to limited broadcast when there is no relay and no ciaddr (broadcast flag is not consulted)', () => {
    const target = chooseReplyTarget(message({ broadcast: true }));
    expect(target).toEqual({ address: LIMITED_BROADCAST, port: DHCP_CLIENT_PORT });
  });

  it('unicasts to ciaddr for a renewing/informing client (no broadcast flag)', () => {
    const target = chooseReplyTarget(message({ ciaddr: '10.0.0.77' }));
    expect(target).toEqual({ address: '10.0.0.77', port: DHCP_CLIENT_PORT });
  });

  it('unicasts to ciaddr even when the client set the broadcast flag (RFC 2131 §4.1)', () => {
    const target = chooseReplyTarget(message({ ciaddr: '10.0.0.77', broadcast: true }));
    expect(target).toEqual({ address: '10.0.0.77', port: DHCP_CLIENT_PORT });
  });

  it('broadcasts to a booting client with no flag and no ciaddr', () => {
    const target = chooseReplyTarget(message());
    expect(target).toEqual({ address: LIMITED_BROADCAST, port: DHCP_CLIENT_PORT });
  });

  it('prefers the relay even when the broadcast flag is set', () => {
    const target = chooseReplyTarget(message({ giaddr: '10.0.0.254', broadcast: true }));
    expect(target).toEqual({ address: '10.0.0.254', port: DHCP_SERVER_PORT });
  });

  it('treats giaddr 255.255.255.255 as not-a-relay (leasequery), falling back to broadcast', () => {
    const target = chooseReplyTarget(message({ giaddr: LIMITED_BROADCAST }));
    expect(target).toEqual({ address: LIMITED_BROADCAST, port: DHCP_CLIENT_PORT });
  });
});

describe('chooseNakTarget', () => {
  it('broadcasts a non-relayed NAK to the client port', () => {
    expect(chooseNakTarget(message())).toEqual({ address: LIMITED_BROADCAST, port: DHCP_CLIENT_PORT });
  });

  it('sends a relayed NAK back to the relay on the server port', () => {
    expect(chooseNakTarget(message({ giaddr: '10.0.0.254' }))).toEqual({
      address: '10.0.0.254',
      port: DHCP_SERVER_PORT,
    });
  });

  it('broadcasts a NAK even when the client unicast its ciaddr (distant-subnet fix)', () => {
    expect(chooseNakTarget(message({ ciaddr: '10.0.0.77' }))).toEqual({
      address: LIMITED_BROADCAST,
      port: DHCP_CLIENT_PORT,
    });
  });

  it('treats giaddr 255.255.255.255 as not-a-relay and broadcasts', () => {
    expect(chooseNakTarget(message({ giaddr: LIMITED_BROADCAST }))).toEqual({
      address: LIMITED_BROADCAST,
      port: DHCP_CLIENT_PORT,
    });
  });
});

describe('sendReply', () => {
  function fakeSocket(): dgram.Socket {
    return {
      setBroadcast: vi.fn(),
      send: vi.fn(),
    } as unknown as dgram.Socket;
  }

  it('enables broadcast before a limited-broadcast send', () => {
    const socket = fakeSocket();
    const packet = Buffer.from([1, 2, 3]);
    sendReply(socket, packet, { address: LIMITED_BROADCAST, port: DHCP_CLIENT_PORT }, vi.fn());
    expect(socket.setBroadcast).toHaveBeenCalledWith(true);
    expect(socket.send).toHaveBeenCalledWith(packet, DHCP_CLIENT_PORT, LIMITED_BROADCAST, expect.any(Function));
  });

  it('does not enable broadcast for a unicast send', () => {
    const socket = fakeSocket();
    sendReply(socket, Buffer.from([1]), { address: '10.0.0.7', port: DHCP_CLIENT_PORT }, vi.fn());
    expect(socket.setBroadcast).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledWith(Buffer.from([1]), DHCP_CLIENT_PORT, '10.0.0.7', expect.any(Function));
  });

  it('routes a send failure to onError', () => {
    const socket = fakeSocket();
    const onError = vi.fn();
    vi.mocked(socket.send).mockImplementation(
      (_msg: string | ArrayBufferView, _port?: unknown, _address?: unknown, callback?: unknown) => {
        (callback as (err: Error | null) => void)(new Error('send boom'));
      },
    );
    sendReply(socket, Buffer.from([1]), { address: '10.0.0.7', port: 68 }, onError);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'send boom' }));
  });

  it('routes a broadcast send failure to onError after enabling broadcast', () => {
    const socket = fakeSocket();
    const onError = vi.fn();
    vi.mocked(socket.send).mockImplementation(
      (_msg: string | ArrayBufferView, _port?: unknown, _address?: unknown, callback?: unknown) => {
        (callback as (err: Error | null) => void)(new Error('send boom'));
      },
    );
    sendReply(socket, Buffer.from([1]), { address: LIMITED_BROADCAST, port: DHCP_CLIENT_PORT }, onError);
    expect(socket.setBroadcast).toHaveBeenCalledWith(true);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'send boom' }));
  });
});
