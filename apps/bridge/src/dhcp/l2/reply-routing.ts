import { DHCP_CLIENT_PORT, DHCP_SERVER_PORT, LIMITED_BROADCAST, type ReplyTarget } from '../broadcast-socket.js';

const ZERO_IP = '0.0.0.0';

export type ReplyTransport =
  | { kind: 'dgram-unicast'; target: ReplyTarget }
  | { kind: 'dgram-broadcast'; target: ReplyTarget }
  | { kind: 'afpacket-unicast'; target: ReplyTarget; chaddr: Buffer }
  | { kind: 'afpacket-broadcast'; target: ReplyTarget };

export interface ReplyRoutingInput {
  /** giaddr from the DHCP request */
  giaddr: string;
  /** ciaddr from the DHCP request */
  ciaddr: string;
  /** Whether the broadcast flag (bit 15 of flags) is set */
  broadcastFlag: boolean;
  /** The yiaddr being assigned in the reply */
  yiaddr: string;
  /** Whether AF_PACKET send is available on the ingress interface */
  afpacketAvailable: boolean;
  /** Client hardware address as a raw 6-byte Buffer (carried through to afpacket-unicast) */
  chaddr: Buffer;
}

/** Choose the reply transport, honoring RFC 2131 precedence: relay giaddr, then ciaddr, then the broadcast flag. */
export function chooseReplyRoute(input: ReplyRoutingInput): ReplyTransport {
  const { giaddr, ciaddr, broadcastFlag, yiaddr, afpacketAvailable, chaddr } = input;

  // 1. Relay agent — always dgram unicast to the relay
  if (giaddr !== ZERO_IP && giaddr !== LIMITED_BROADCAST) {
    return { kind: 'dgram-unicast', target: { address: giaddr, port: DHCP_SERVER_PORT } };
  }

  // 2. Renewing/rebinding client with ciaddr — dgram unicast
  if (ciaddr !== ZERO_IP) {
    return { kind: 'dgram-unicast', target: { address: ciaddr, port: DHCP_CLIENT_PORT } };
  }

  // 3. Unconfigured client (INIT/SELECTING/INIT-REBOOT with no ciaddr)
  if (broadcastFlag) {
    // Client requests broadcast — honor it
    if (afpacketAvailable) {
      return { kind: 'afpacket-broadcast', target: { address: LIMITED_BROADCAST, port: DHCP_CLIENT_PORT } };
    }
    return { kind: 'dgram-broadcast', target: { address: LIMITED_BROADCAST, port: DHCP_CLIENT_PORT } };
  }

  // Broadcast flag CLEAR — client wants unicast to its hardware address
  if (afpacketAvailable) {
    return {
      kind: 'afpacket-unicast',
      target: { address: yiaddr !== ZERO_IP ? yiaddr : LIMITED_BROADCAST, port: DHCP_CLIENT_PORT },
      chaddr,
    };
  }

  // AF_PACKET unavailable — fall back to dgram broadcast (the pre-existing behavior)
  return { kind: 'dgram-broadcast', target: { address: LIMITED_BROADCAST, port: DHCP_CLIENT_PORT } };
}

/** NAKs are always broadcast per RFC 2131 §4.3.1, except relayed ones, which return to the relay. */
export function chooseNakRoute(input: Pick<ReplyRoutingInput, 'giaddr' | 'afpacketAvailable'>): ReplyTransport {
  const { giaddr, afpacketAvailable } = input;

  if (giaddr !== ZERO_IP && giaddr !== LIMITED_BROADCAST) {
    return { kind: 'dgram-unicast', target: { address: giaddr, port: DHCP_SERVER_PORT } };
  }

  if (afpacketAvailable) {
    return { kind: 'afpacket-broadcast', target: { address: LIMITED_BROADCAST, port: DHCP_CLIENT_PORT } };
  }
  return { kind: 'dgram-broadcast', target: { address: LIMITED_BROADCAST, port: DHCP_CLIENT_PORT } };
}
