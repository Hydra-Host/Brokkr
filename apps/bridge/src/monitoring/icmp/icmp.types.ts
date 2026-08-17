import type { PingBatchRequest } from '../monitoring.schema';

export interface IcmpPingMetrics {
  icmpping: number;
  icmppingloss: number;
  icmppingsec: number | null;
  'icmppingsec.min': number | null;
  'icmppingsec.max': number | null;
  'icmppingsec.avg': number | null;
  packets_sent?: number;
  packets_received?: number;
  rtt_mdev_ms?: number | null;
  jitter_ms?: number;
}

export interface IcmpPingResult {
  result: 'success' | 'failure';
  target_ip: string;
  metrics: IcmpPingMetrics;
  error?: string;
}

export interface IcmpPingBatchResult {
  total_targets: number;
  successful: number;
  failed: number;
  results: Array<Record<string, unknown>>;
}

export interface IcmpPingTestArgs {
  ip: string;
  count: number;
  timeout: number;
  packetSize: number;
  interval: number;
  extendedMetrics: boolean;
}

export interface IcmpBatchPingTestArgs {
  targets: PingBatchRequest['targets'];
  defaultCount: number;
  defaultTimeout: number;
  defaultPacketSize: number;
}

export interface IcmpService {
  executePingTest(args: IcmpPingTestArgs): Promise<IcmpPingResult>;
  executeBatchPingTest(args: IcmpBatchPingTestArgs): Promise<IcmpPingBatchResult>;
}

export interface IcmpServiceFactory {
  create(jobId: string): IcmpService;
}

export const ICMP_SERVICE_FACTORY = 'ICMP_SERVICE_FACTORY';

export class IcmpMonitoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IcmpMonitoringError';
  }
}
