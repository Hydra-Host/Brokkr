import { isIP } from 'node:net';

import { Injectable } from '@nestjs/common';
import { runWithConcurrency } from '@repo/utils';
import { getErrorMessage } from '../../common/error-utils';

import { missingBridgeHostnames, subnetMatchEntries } from '../../bridge-network/bridge-registry-reader';
import { stripV4MappedPrefix } from '../../bridge-network/peer-anchor-resolver';
import type {
  BridgeEndpoint,
  BridgeRegistryReaderPort,
  BridgeSnapshot,
  ConnectionRegistryPort,
  GrpcConfigPort,
  PeerAnchorPort,
  PeerHostsResult,
  SnapshotDiff,
  TopologyBroadcasterLogger,
} from './topology-broadcaster.types';

export const DEFAULT_POLL_INTERVAL_MS = 30_000;

// Bounds cold-cache anchor probes after a restart, when every session misses at once.
const ANCHOR_RESOLVE_CONCURRENCY = 8;

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

// Eligibility comes from `liveSnapshot` so a bridge that left the registry is not reported missing.
export async function hostsEntriesForPeer(
  peerIp: string | null,
  snapshot: BridgeSnapshot,
  anchorResolver: PeerAnchorPort,
  liveSnapshot: BridgeSnapshot = snapshot,
): Promise<PeerHostsResult> {
  if (!peerIp) return { hostsEntries: [], missingBridges: [] };
  const clientIp = stripV4MappedPrefix(peerIp);
  if (isIP(clientIp) === 0) return { hostsEntries: [], missingBridges: [] };

  let entries = subnetMatchEntries(snapshot, clientIp);
  let missingBridges = missingBridgeHostnames(
    liveSnapshot,
    entries.map(([, hostname]) => hostname),
  );
  if (missingBridges.length > 0) {
    const anchor = await resolveAnchorSafely(anchorResolver, clientIp);
    if (anchor !== null) {
      entries = subnetMatchEntries(snapshot, clientIp, anchor);
      missingBridges = missingBridgeHostnames(
        liveSnapshot,
        entries.map(([, hostname]) => hostname),
      );
    }
  }
  return { hostsEntries: entries.map(([ip, hostname]) => ({ ip, hostname })), missingBridges };
}

async function resolveAnchorSafely(anchorResolver: PeerAnchorPort, clientIp: string): Promise<string | null> {
  try {
    return await anchorResolver.resolve(clientIp);
  } catch {
    return null;
  }
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
    private readonly anchorResolver: PeerAnchorPort,
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
    const liveSnapshot = await this.reader.getBridgeRegistrySnapshot(jobId);
    for (const [hostname, interfaces] of liveSnapshot) {
      if (interfaces.length > 0) this.stickyInterfaces.set(hostname, interfaces);
    }
    const registrySnapshot = sortedSnapshotFromMap(this.stickyInterfaces);
    await this.broadcast(endpoints, registrySnapshot, liveSnapshot, jobId);
  }

  private async broadcast(
    bridges: readonly BridgeEndpoint[],
    registrySnapshot: BridgeSnapshot,
    liveSnapshot: BridgeSnapshot,
    jobId: string,
  ): Promise<void> {
    const handles = await this.registry.snapshotSessionHandles();
    const results = await runWithConcurrency(
      handles.map(
        (handle) => () => hostsEntriesForPeer(handle.peerIp, registrySnapshot, this.anchorResolver, liveSnapshot),
      ),
      ANCHOR_RESOLVE_CONCURRENCY,
    );
    let dropped = 0;
    let partial = 0;
    const missing = new Set<string>();
    handles.forEach((handle, i) => {
      const { hostsEntries, missingBridges } = results[i];
      if (missingBridges.length > 0) {
        partial += 1;
        for (const hostname of missingBridges) missing.add(hostname);
      }
      const ok = handle.enqueue({
        topologyUpdate: { bridges, hostsEntries },
      });
      if (!ok) dropped += 1;
    });
    if (partial > 0) {
      await this.logger.warning(
        `topology broadcaster: partial hostsEntries for ${partial}/${handles.length} sessions; unresolved bridges=${formatSorted(missing)}`,
        jobId,
      );
    }
    if (dropped > 0) {
      await this.logger.debug(
        `topology broadcaster: dropped ${dropped}/${handles.length} pushes due to full queues`,
        jobId,
      );
    }
  }
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
