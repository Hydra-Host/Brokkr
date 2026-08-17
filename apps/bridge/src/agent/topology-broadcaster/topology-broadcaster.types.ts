export interface BridgeEndpoint {
  address: string;
  bridgeId: string;
}

export interface HostsEntry {
  ip: string;
  hostname: string;
}

export interface InterfaceEntry {
  iface?: string;
  mac?: string;
  subnet?: string;
  ip?: string;
}

export type BridgeSnapshotEntry = readonly [hostname: string, interfaces: readonly unknown[]];

export type BridgeSnapshot = readonly BridgeSnapshotEntry[];

export type LogKind = 'initial' | 'unchanged' | 'change';

export interface SnapshotDiff {
  shouldBroadcast: boolean;
  added: ReadonlySet<string>;
  removed: ReadonlySet<string>;
  logKind: LogKind;
}

export interface TopologyUpdateMessage {
  bridges: readonly BridgeEndpoint[];
  hostsEntries: readonly HostsEntry[];
}

export interface TopologyServerMessage {
  topologyUpdate: TopologyUpdateMessage;
}

export interface SessionHandle {
  peerIp: string | null;
  enqueue: (msg: TopologyServerMessage) => boolean;
}

export interface ConnectionRegistryPort {
  snapshotSessionHandles(): Promise<readonly SessionHandle[]>;
}

export interface BridgeRegistryReaderPort {
  getAllBridgeHostnames(jobId: string): Promise<readonly string[]>;
  getBridgeRegistrySnapshot(jobId: string): Promise<BridgeSnapshot>;
}

export interface TopologyBroadcasterLogger {
  debug(msg: string, jobId: string): void | Promise<void>;
  info(msg: string, jobId: string): void | Promise<void>;
  warning(msg: string, jobId: string): void | Promise<void>;
}

export interface GrpcConfigPort {
  externalPort: number;
}
