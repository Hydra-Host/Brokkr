import { Address4, Address6 } from 'ip-address';

export enum PrefixStatus {
  Container = 'container',
  Active = 'active',
  Reserved = 'reserved',
  Deprecated = 'deprecated',
}

export interface PrefixConfig {
  id: string;
  prefix: string;
  status: PrefixStatus;
  vrfId?: string;
  isPool?: boolean;
}

export class Prefix {
  readonly id: string;
  readonly prefix: string;
  readonly status: PrefixStatus;
  readonly vrfId?: string;
  readonly isPool: boolean;

  private addr: Address4 | Address6;

  constructor(config: PrefixConfig) {
    this.id = config.id;
    this.prefix = config.prefix;
    this.status = config.status;
    this.vrfId = config.vrfId;
    this.isPool = config.isPool ?? false;

    try {
      this.addr = this.prefix.includes(':') ? new Address6(this.prefix) : new Address4(this.prefix);
    } catch (_e) {
      throw new Error(`Invalid prefix format: ${this.prefix}`);
    }

    this.validate();
  }

  get version(): 4 | 6 {
    return this.addr.v4 ? 4 : 6;
  }

  get maskLength(): number {
    return this.addr.subnetMask;
  }

  calculateUtilization(childPrefixes: Prefix[], ipAddresses: unknown[]): number {
    const totalSize = this.totalAddressCount();
    let occupiedSize = BigInt(0);

    if (this.status === PrefixStatus.Container) {
      occupiedSize = childPrefixes.reduce((acc, child) => acc + child.totalAddressCount(), BigInt(0));
    } else {
      occupiedSize = BigInt(ipAddresses.length);
    }

    if (totalSize === BigInt(0)) return 0;
    return Number((occupiedSize * BigInt(100)) / totalSize);
  }

  contains(other: Prefix): boolean {
    if (this.version !== other.version || this.vrfId !== other.vrfId) {
      return false;
    }
    return other.addr.isInSubnet(this.addr);
  }

  overlaps(other: Prefix): boolean {
    if (this.version !== other.version || this.vrfId !== other.vrfId) {
      return false;
    }
    return this.contains(other) || other.contains(this);
  }

  getFirstAvailableIp(existingIps: string[]): string | null {
    if (this.status === PrefixStatus.Container) {
      throw new Error('Cannot get available IP from a container prefix.');
    }

    const ips = existingIps
      .map((ip) => (this.version === 4 ? new Address4(ip) : new Address6(ip)).bigInt())
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const startIp = this.addr.startAddress().bigInt();
    const endIp = this.addr.endAddress().bigInt();

    let candidate = startIp;
    if (!this.isPool && this.version === 4) {
      candidate += BigInt(1);
    }

    for (const ip of ips) {
      if (ip === candidate) {
        candidate += BigInt(1);
      } else if (ip > candidate) {
        break;
      }
    }

    const allowLast = this.isPool || this.version === 6;
    return (allowLast ? candidate <= endIp : candidate < endIp) ? this.formatBigIntToIp(candidate) : null;
  }

  getDepth(allPrefixes: Prefix[]): number {
    return allPrefixes.filter((p) => p.id !== this.id && p.contains(this)).length;
  }

  private totalAddressCount(): bigint {
    const bits = this.version === 4 ? 32 : 128;
    return BigInt(2) ** BigInt(bits - this.maskLength);
  }

  private formatBigIntToIp(bn: bigint): string {
    return this.version === 4 ? Address4.fromBigInt(bn).address : Address6.fromBigInt(bn).address;
  }

  private validate(): void {
    const networkAddress = this.addr.startAddress().address;
    const cidrAddress = this.prefix.split('/')[0];

    if (networkAddress !== cidrAddress) {
      throw new Error(
        `Invalid prefix: ${this.prefix}. Host bits must be zero. Did you mean ${networkAddress}/${this.maskLength}?`,
      );
    }

    if (this.version === 4 && (this.maskLength < 0 || this.maskLength > 32)) {
      throw new Error('IPv4 mask must be between 0 and 32.');
    }
    if (this.version === 6 && (this.maskLength < 0 || this.maskLength > 128)) {
      throw new Error('IPv6 mask must be between 0 and 128.');
    }
  }
}
