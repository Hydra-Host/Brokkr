import { Injectable } from '@nestjs/common';
import { getErrorMessage } from '../../common/error-utils';

import { parseAddress, subnetMatchEntries } from './subnet-match';
import type {
  BridgeEndpoint,
  BridgeRegistryReaderPort,
  BridgeSnapshot,
  ConnectionRegistryPort,
  GrpcConfigPort,
  HostsEntry,
  SessionHandle,
  SnapshotDiff,
  TopologyBroadcasterLogger,
} from './topology-broadcaster.types';

export const DEFAULT_POLL_INTERVAL_MS = 30_000;

export function buildEndpoints(hostnames: Iterable<string>, port: number): BridgeEndpoint[] {
  const endpoints: BridgeEndpoint[] = [];
  for (const host of hostnames) {
    endpoints.push({ address: `${host}:${port}`, bridgeId: host });
  }
  return endpoints;
}

export function diffTopologySnapshot(prev: ReadonlySet<string> | null, curr: ReadonlySet<string>): SnapshotDiff {
  if (prev !== null && setsEqual(prev, curr)) {
    return { shouldBroadcast: false, added: new Set(), removed: new Set(), logKind: 'unchanged' };
  }
  if (prev === null) {
    return { shouldBroadcast: true, added: new Set(curr), removed: new Set(), logKind: 'initial' };
  }
  return {
    shouldBroadcast: true,
    added: setDifference(curr, prev),
    removed: setDifference(prev, curr),
    logKind: 'change',
  };
}

export function hostsEntriesForPeer(peerIp: string | null, snapshot: BridgeSnapshot): HostsEntry[] {
  if (!peerIp) return [];
  const clientAddr = parseAddress(peerIp);
  if (clientAddr === null) return [];
  return subnetMatchEntries(snapshot, clientAddr).map(([ip, hostname]) => ({ ip, hostname }));
}

@Injectable()
export class TopologyBroadcasterService {
  private lastSnapshot: ReadonlySet<string> | null = null;
  private readonly stickyHostnames = new Set<string>();
  private readonly stickyInterfaces = new Map<string, readonly unknown[]>();
  private stopped = false;
  private wake: (() => void) | null = null;

  constructor(
    private readonly registry: ConnectionRegistryPort,
    private readonly reader: BridgeRegistryReaderPort,
    private readonly grpcConfig: GrpcConfigPort,
    private readonly logger: TopologyBroadcasterLogger,
    private readonly pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  ) {}

  async runForever(jobId = ''): Promise<void> {
    await this.logger.info('topology broadcaster started', jobId);
    while (!this.stopped) {
      try {
        await this.pollOnce(jobId);
      } catch (error) {
        await this.logger.warning(`topology broadcaster tick failed, will retry: ${getErrorMessage(error)}`, jobId);
      }
      if (this.stopped) break;
      await this.sleepUntilStopped(this.pollIntervalMs);
    }
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  // woken by stop(): a plain sleep would keep the event loop referenced for a full poll interval
  // after Nest's shutdown sweep, which is what stranded the process.
  private sleepUntilStopped(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = (): void => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  async pollOnce(jobId: string): Promise<void> {
    const hostnames = await this.reader.getAllBridgeHostnames(jobId);
    if (hostnames.length === 0) {
      await this.logger.warning(
        'topology broadcaster: registry returned empty while this bridge is live — skipping broadcast',
        jobId,
      );
      return;
    }

    for (const host of hostnames) {
      this.stickyHostnames.add(host);
    }
    const snapshot: ReadonlySet<string> = new Set(this.stickyHostnames);

    const diff = diffTopologySnapshot(this.lastSnapshot, snapshot);
    if (!diff.shouldBroadcast) return;

    this.lastSnapshot = snapshot;

    if (diff.logKind === 'initial') {
      await this.logger.info(
        `topology broadcaster: initial snapshot bridges=${formatSorted(snapshot)}; broadcasting to all sessions`,
        jobId,
      );
    } else {
      await this.logger.info(
        `topology broadcaster: fleet grew added=${formatSorted(diff.added)} (total=${formatSorted(snapshot)})`,
        jobId,
      );
    }

    const sortedHostnames = [...snapshot].sort();
    const endpoints = buildEndpoints(sortedHostnames, this.grpcConfig.externalPort);
    for (const [hostname, interfaces] of await this.reader.getBridgeRegistrySnapshot(jobId)) {
      if (interfaces.length > 0) this.stickyInterfaces.set(hostname, interfaces);
    }
    const registrySnapshot = sortedSnapshotFromMap(this.stickyInterfaces);
    await this.broadcast(endpoints, registrySnapshot, jobId);
  }

  private async broadcast(
    bridges: readonly BridgeEndpoint[],
    registrySnapshot: BridgeSnapshot,
    jobId: string,
  ): Promise<void> {
    const handles = await this.registry.snapshotSessionHandles();
    let dropped = 0;
    for (const handle of handles) {
      const hostsEntries = hostsEntriesForHandle(handle, registrySnapshot);
      const ok = handle.enqueue({
        topologyUpdate: { bridges, hostsEntries },
      });
      if (!ok) dropped += 1;
    }
    if (dropped > 0) {
      await this.logger.debug(
        `topology broadcaster: dropped ${dropped}/${handles.length} pushes due to full queues`,
        jobId,
      );
    }
  }
}

export function hostsEntriesForHandle(handle: SessionHandle, snapshot: BridgeSnapshot): HostsEntry[] {
  return hostsEntriesForPeer(handle.peerIp, snapshot);
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}

function setDifference(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const v of a) {
    if (!b.has(v)) out.add(v);
  }
  return out;
}

function formatSorted(values: ReadonlySet<string>): string {
  const sorted = [...values].sort();
  return `[${sorted.map((v) => `'${v}'`).join(', ')}]`;
}

function sortedSnapshotFromMap(map: ReadonlyMap<string, readonly unknown[]>): BridgeSnapshot {
  return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}
