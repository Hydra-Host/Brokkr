// The native AF_PACKET addon is loaded lazily so its absence (non-Linux, missing build) surfaces
// as a clear runtime error, never a module-load crash.

import { getErrorMessage } from '../../common/error-utils.js';

export interface RawFrame {
  /** Linux interface index the frame arrived on. */
  ifindex: number;
  /** Source MAC from the Ethernet header, 6 bytes. */
  srcMac: Buffer;
  /** The full Ethernet frame (header + IPv4 + UDP + payload). */
  frame: Buffer;
}

export interface PacketSocket {
  /** Register a handler for incoming frames; the bind-time BPF filter delivers only broadcast DHCP frames. */
  onFrame(handler: (frame: RawFrame) => void): void;

  // Send on a closed socket is a silent no-op; a transport failure on an open socket must throw —
  // callers rely on the throw to fall back to dgram broadcast. Do not swallow open-socket errors.
  send(ifindex: number, dstMac: Buffer, frame: Buffer): void;

  /** Shut down the socket, releasing the file descriptor. */
  close(): void;

  /** Whether this socket is backed by a real AF_PACKET fd. */
  readonly isNative: boolean;

  /** Linux interface index resolved at socket creation time. */
  readonly ifindex: number;

  /** Hardware (MAC) address of the bound interface, 6 bytes. */
  readonly ifMac: Buffer;
}

export class InMemoryPacketSocket implements PacketSocket {
  readonly isNative = false;
  readonly ifindex: number;
  readonly ifMac: Buffer;
  readonly sent: Array<{ ifindex: number; dstMac: Buffer; frame: Buffer }> = [];

  private handler: ((frame: RawFrame) => void) | null = null;
  private closed = false;
  private readonly sendError?: Error;

  constructor(ifindex = 0, ifMac?: Buffer, sendError?: Error) {
    this.ifindex = ifindex;
    this.ifMac = ifMac ?? Buffer.alloc(6);
    this.sendError = sendError;
  }

  onFrame(handler: (frame: RawFrame) => void): void {
    this.handler = handler;
  }

  send(ifindex: number, dstMac: Buffer, frame: Buffer): void {
    // No-op on a closed socket — matches NativePacketSocket (see the interface contract).
    if (this.closed) return;
    if (this.sendError) throw this.sendError;
    this.sent.push({ ifindex, dstMac: Buffer.from(dstMac), frame: Buffer.from(frame) });
  }

  close(): void {
    this.closed = true;
    this.handler = null;
  }

  /** Test helper: inject a frame as if received from the kernel. */
  inject(raw: RawFrame): void {
    this.handler?.(raw);
  }
}

export class PacketSocketUnavailableError extends Error {
  constructor(reason: string) {
    super(`AF_PACKET socket unavailable: ${reason}`);
    this.name = 'PacketSocketUnavailableError';
  }
}

/** Shape of the native addon's exports — only typed here, implemented in C. */
interface AfpacketAddon {
  create(
    ifname: string,
    bpfFilter: number[][],
  ): {
    ifindex: number;
    mac: Buffer;
    onFrame: (cb: (ifindex: number, srcMac: Buffer, frame: Buffer) => void) => void;
    send: (ifindex: number, dstMac: Buffer, frame: Buffer) => void;
    close: () => void;
  };
}

let addon: AfpacketAddon | null | false = null; // null = not tried, false = unavailable

function loadAddon(): AfpacketAddon {
  if (addon === false) throw new PacketSocketUnavailableError('native addon previously failed to load');
  if (addon !== null) return addon;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../../../native/afpacket/build/Release/afpacket.node') as AfpacketAddon;
    addon = mod;
    return mod;
  } catch (error) {
    addon = false;
    throw new PacketSocketUnavailableError(getErrorMessage(error));
  }
}

export class NativePacketSocket implements PacketSocket {
  readonly isNative = true;
  readonly ifindex: number;
  readonly ifMac: Buffer;
  private handle: ReturnType<AfpacketAddon['create']>;
  private closed = false;

  constructor(ifname: string) {
    const mod = loadAddon();
    this.handle = mod.create(ifname, DHCP_BROADCAST_BPF);
    this.ifindex = this.handle.ifindex;
    this.ifMac = Buffer.from(this.handle.mac);
  }

  onFrame(handler: (frame: RawFrame) => void): void {
    this.handle.onFrame((ifindex, srcMac, frame) => {
      handler({ ifindex, srcMac, frame });
    });
  }

  send(ifindex: number, dstMac: Buffer, frame: Buffer): void {
    // No-op a send racing close() rather than let the addon throw EBADF on a released fd;
    // live-fd transport errors still propagate per the PacketSocket.send contract.
    if (this.closed) return;
    this.handle.send(ifindex, dstMac, frame);
  }

  close(): void {
    this.closed = true;
    this.handle.close();
  }
}

// Matches only broadcast DHCP (IPv4 + UDP dst 67 to 255.255.255.255) so unicast renewals stay on dgram.
// Offsets assume IHL=5; packets with IP options shift the UDP header past 36 and are silently dropped.
export const DHCP_BROADCAST_BPF: number[][] = [
  // [0] Load EtherType (offset 12, half-word)
  [0x28, 0, 0, 12],
  // [1] Jump if == 0x0800 (IPv4), else reject at [9]
  [0x15, 0, 7, 0x0800],
  // [2] Load IP protocol (offset 23, byte) — 14 (eth) + 9 (proto offset in IP header)
  [0x30, 0, 0, 23],
  // [3] Jump if == 17 (UDP), else reject at [9]
  [0x15, 0, 5, 17],
  // [4] Load IP dst address (offset 30, word) — 14 (eth) + 16 (dst IP offset in IP header)
  [0x20, 0, 0, 30],
  // [5] Jump if == 0xFFFFFFFF (255.255.255.255), else reject at [9]
  [0x15, 0, 3, 0xffffffff],
  // [6] Load UDP dst port (offset 36, half-word) — 14 (eth) + 20 (IP header) + 2 (dst port offset)
  [0x28, 0, 0, 36],
  // [7] Jump if == 67, else reject at [9]
  [0x15, 0, 1, 67],
  // [8] Accept: return 65535 (capture whole packet)
  [0x06, 0, 0, 0x0000ffff],
  // [9] Reject: return 0
  [0x06, 0, 0, 0x00000000],
];

// addon-unavailable is permanent host-wide (disable AF_PACKET everywhere); nic-error is transient
// (retry next reconcile). Discriminated on `kind`: strictNullChecks is off, breaking boolean narrowing.
export type NativeSocketResult =
  | { kind: 'ok'; socket: PacketSocket }
  | { kind: 'addon-unavailable'; reason: string }
  | { kind: 'nic-error'; nicError: string };

// EPERM/EACCES = missing CAP_NET_RAW: host-wide and permanent, so it must classify as
// addon-unavailable rather than a per-NIC error that gets re-probed every reconcile.
const PERMANENT_ERRNO_PATTERNS = ['EPERM', 'EACCES', 'Operation not permitted', 'Permission denied'];

function isPermanentCapabilityError(message: string): boolean {
  return PERMANENT_ERRNO_PATTERNS.some((pattern) => message.includes(pattern));
}

export function tryCreateNativeSocket(ifname: string): NativeSocketResult {
  try {
    return { kind: 'ok', socket: new NativePacketSocket(ifname) };
  } catch (error) {
    if (error instanceof PacketSocketUnavailableError) {
      return { kind: 'addon-unavailable', reason: getErrorMessage(error) };
    }
    const message = getErrorMessage(error);
    if (isPermanentCapabilityError(message)) {
      return { kind: 'addon-unavailable', reason: message };
    }
    return { kind: 'nic-error', nicError: message };
  }
}
