import type * as dgram from 'node:dgram';

import { type NetworkInterface, ipInCidr } from '../bridge-network/self-network.js';
import { getErrorMessage } from '../common/error-utils.js';
import { logDebug } from '../logger/logger.service.js';
import { DHCP_SERVER_PORT } from './broadcast-socket.js';

export interface ReplySocketLogger {
  info(message: string): void;
  warn(message: string): void;
}

interface BoundReplySocket {
  socket: dgram.Socket;
  network: string;
  interface: string;
}

export class ReplySocketSet {
  private readonly byIp = new Map<string, BoundReplySocket>();
  private readonly desired = new Set<string>();
  private released = false;

  constructor(
    private readonly createSocket: () => dgram.Socket,
    private readonly enumerate: () => NetworkInterface[],
    private readonly logger: ReplySocketLogger,
  ) {}

  async refresh(): Promise<void> {
    if (this.released) return;
    const ifaces = this.enumerate();
    this.desired.clear();
    for (const iface of ifaces) this.desired.add(iface.ip);
    for (const iface of ifaces) {
      const existing = this.byIp.get(iface.ip);
      if (existing) {
        // Same IP but a changed CIDR must rebind, else socketFor routes on a stale network.
        if (existing.network === iface.network) continue;
        this.closeSocket(existing.socket);
        this.byIp.delete(iface.ip);
      }
      await this.bindOne(iface);
    }
    for (const [ip, bound] of [...this.byIp]) {
      if (this.desired.has(ip)) continue;
      this.closeSocket(bound.socket);
      this.byIp.delete(ip);
    }
  }

  socketFor(address: string): dgram.Socket | null {
    for (const bound of this.byIp.values()) {
      if (ipInCidr(bound.network, address)) return bound.socket;
    }
    return null;
  }

  closeAll(): void {
    this.released = true;
    for (const bound of this.byIp.values()) {
      this.closeSocket(bound.socket);
    }
    this.byIp.clear();
  }

  private bindOne(iface: NetworkInterface): Promise<void> {
    const socket = this.createSocket();
    return new Promise<void>((resolve) => {
      const onError = (error: Error): void => {
        this.logger.warn(
          `DHCP reply-socket bind failed on ${iface.name} ${iface.ip}:${DHCP_SERVER_PORT}: ${getErrorMessage(error)}`,
        );
        this.closeSocket(socket);
        resolve();
      };
      socket.once('error', onError);
      socket.bind(DHCP_SERVER_PORT, iface.ip, () => {
        socket.removeListener('error', onError);
        if (this.released) {
          this.closeSocket(socket);
          resolve();
          return;
        }
        try {
          socket.setBroadcast(true);
        } catch (error) {
          this.logger.warn(`DHCP reply-socket setBroadcast failed on ${iface.ip}: ${getErrorMessage(error)}`);
          this.closeSocket(socket);
          resolve();
          return;
        }
        // A concurrent refresh may have dropped this iface while the async bind was in flight; discard rather than leave a stale binding in byIp.
        if (this.released || !this.desired.has(iface.ip)) {
          this.closeSocket(socket);
          resolve();
          return;
        }
        socket.on('error', (error: Error) => {
          this.logger.warn(`DHCP reply-socket error on ${iface.ip}: ${getErrorMessage(error)}`);
          if (this.byIp.get(iface.ip)?.socket === socket) {
            this.closeSocket(socket);
            this.byIp.delete(iface.ip);
          }
        });
        this.byIp.set(iface.ip, { socket, network: iface.network, interface: iface.name });
        this.logger.info(`DHCP reply-socket bound on ${iface.name} ${iface.ip}:${DHCP_SERVER_PORT}`);
        resolve();
      });
    });
  }

  private closeSocket(socket: dgram.Socket): void {
    try {
      socket.close();
    } catch (error) {
      void logDebug(`DHCP reply-socket close failed: ${getErrorMessage(error)}`);
    }
  }
}
