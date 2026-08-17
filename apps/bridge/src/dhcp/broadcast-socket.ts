import type * as dgram from 'node:dgram';

import { getErrorMessage } from '../common/error-utils.js';
import type { DhcpMessage } from './protocol.js';

export const DHCP_SERVER_PORT = 67;
export const DHCP_CLIENT_PORT = 68;
export const LIMITED_BROADCAST = '255.255.255.255';

const ZERO_IP = '0.0.0.0';

export interface ReplyTarget {
  address: string;
  port: number;
}

function isRelay(giaddr: string): boolean {
  return giaddr !== ZERO_IP && giaddr !== LIMITED_BROADCAST;
}

export function chooseReplyTarget(request: DhcpMessage): ReplyTarget {
  if (isRelay(request.giaddr)) {
    return { address: request.giaddr, port: DHCP_SERVER_PORT };
  }
  if (request.ciaddr !== ZERO_IP) {
    return { address: request.ciaddr, port: DHCP_CLIENT_PORT };
  }
  return { address: LIMITED_BROADCAST, port: DHCP_CLIENT_PORT };
}

export function chooseNakTarget(request: DhcpMessage): ReplyTarget {
  if (isRelay(request.giaddr)) {
    return { address: request.giaddr, port: DHCP_SERVER_PORT };
  }
  return { address: LIMITED_BROADCAST, port: DHCP_CLIENT_PORT };
}

export function sendReply(
  socket: dgram.Socket,
  packet: Buffer,
  target: ReplyTarget,
  onError: (error: Error) => void,
): void {
  if (target.address === LIMITED_BROADCAST) {
    try {
      socket.setBroadcast(true);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(getErrorMessage(error)));
      return;
    }
  }
  socket.send(packet, target.port, target.address, (error) => {
    if (error) onError(error);
  });
}
