import { createHash } from 'node:crypto';

import { getErrorMessage } from '../../common/error-utils';
import { logDebug, logWarning } from '../../logger/logger.service';

export const APP_CLASS_NAME = 'metrics-partitioner';

const REFRESH_INTERVAL_SECONDS = 10;

export function ownsDevice(deviceId: string, myId: string, peers: readonly string[]): boolean {
  if (peers.length === 0) return false;
  const sortedPeers = [...peers].sort();
  const idx = sortedPeers.indexOf(myId);
  if (idx === -1) return false;
  const prefix = createHash('sha256').update(deviceId, 'utf8').digest('hex').slice(0, 8);
  return Number.parseInt(prefix, 16) % sortedPeers.length === idx;
}

export interface RegistryEntry {
  instance_id?: string;
  [key: string]: unknown;
}

export interface PartitionerLeaderService {
  readonly instanceId: string;
  getRegisteredInstances(): Promise<RegistryEntry[]>;
}

export type LeaderServiceProvider = () => PartitionerLeaderService | null;

export class BridgePartitioner {
  private peerList: string[] = [];
  private myId = '';
  private running = false;
  private lastLogged: [number, number] | null = null;

  constructor(
    private readonly getLeaderService: LeaderServiceProvider,
    readonly jobId: string = '',
  ) {}

  peers(): string[] {
    return [...this.peerList];
  }

  getMyId(): string {
    return this.myId;
  }

  owns(deviceId: string): boolean {
    return ownsDevice(deviceId, this.myId, this.peerList);
  }

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        await this.refreshPeers();
      } catch (error) {
        void logWarning(`partitioner refresh failed: ${getErrorMessage(error)}`, {
          jobId: this.jobId,
          appClassName: APP_CLASS_NAME,
        });
      }
      await sleep(REFRESH_INTERVAL_SECONDS * 1000);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async refreshPeers(): Promise<void> {
    const leader = this.getLeaderService();
    if (leader === null) {
      this.setPeers([], '');
      return;
    }

    this.myId = leader.instanceId;
    let instances: RegistryEntry[];
    try {
      instances = await leader.getRegisteredInstances();
    } catch (error) {
      void logDebug(`peer discovery via leader registry failed: ${getErrorMessage(error)}`, {
        jobId: this.jobId,
        appClassName: APP_CLASS_NAME,
      });
      return;
    }

    const seen = new Set<string>();
    for (const entry of instances) {
      const id = entry.instance_id;
      if (typeof id === 'string' && id !== '') seen.add(id);
    }
    let ids = [...seen].sort();
    if (this.myId && !ids.includes(this.myId)) {
      ids = [...ids, this.myId].sort();
    }

    this.setPeers(ids, this.myId);
  }

  private setPeers(ids: string[], myId: string): void {
    if (arraysEqual(ids, this.peerList) && myId === this.myId) return;
    this.peerList = ids;
    this.myId = myId;
    const count = ids.length;
    const idx = myId ? ids.indexOf(myId) : -1;
    if (this.lastLogged === null || this.lastLogged[0] !== idx || this.lastLogged[1] !== count) {
      this.lastLogged = [idx, count];
    }
  }
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let partitioner: BridgePartitioner | null = null;

export function getPartitioner(): BridgePartitioner | null {
  return partitioner;
}

export function installPartitioner(p: BridgePartitioner): void {
  partitioner = p;
}
