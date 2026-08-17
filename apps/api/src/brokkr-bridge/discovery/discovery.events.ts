import type { ZodIssue } from 'zod';

export const DiscoveryEvent = {
  RunStarted: 'discovery.run.started',
  CollectorReceived: 'discovery.collector.received',
  CollectorInvalid: 'discovery.collector.invalid',
  CollectorApplied: 'discovery.collector.applied',
  CollectorFailed: 'discovery.collector.failed',
  ComposerApplied: 'discovery.composer.applied',
  ComposerFailed: 'discovery.composer.failed',
  RunCompleted: 'discovery.run.completed',
  RunFailed: 'discovery.run.failed',
} as const;

export type DiscoveryEventName = (typeof DiscoveryEvent)[keyof typeof DiscoveryEvent];

export interface DiscoveryRunStartedEvent {
  runId: string;
  deviceId: string;
  jobId: string;
  zonePrefix: string;
  startedAt: Date;
}

export interface DiscoveryCollectorReceivedEvent {
  runId: string;
  deviceId: string;
  collector: string;
  rawBytes: number;
}

export interface DiscoveryCollectorInvalidEvent {
  runId: string;
  deviceId: string;
  collector: string;
  issues: ZodIssue[];
}

export interface DiscoveryCollectorAppliedEvent {
  runId: string;
  deviceId: string;
  collector: string;
  warnings: string[];
  deviceUpdateKeys: string[];
  serverUpdateKeys: string[];
  upsertCounts: Record<string, number>;
}

export interface DiscoveryCollectorFailedEvent {
  runId: string;
  deviceId: string;
  collector: string;
  error: string;
}

export interface DiscoveryComposerAppliedEvent {
  runId: string;
  deviceId: string;
  composer: string;
  warnings: string[];
}

export interface DiscoveryComposerFailedEvent {
  runId: string;
  deviceId: string;
  composer: string;
  error: string;
}

export interface DiscoveryRunCompletedEvent {
  runId: string;
  deviceId: string;
  zonePrefix: string;
  jobId: string;
  storageLayouts: unknown;
  rawBundle: Record<string, unknown>;
  collectorsApplied: string[];
  collectorsSkipped: string[];
  composersApplied: string[];
  issueCount: number;
  durationMs: number;
}

export interface DiscoveryRunFailedEvent {
  runId: string;
  deviceId: string;
  jobId: string;
  phase: 'ingress' | 'schema' | 'handler' | 'composer' | 'commit';
  error: string;
}

export interface DiscoveryEventPayloads {
  [DiscoveryEvent.RunStarted]: DiscoveryRunStartedEvent;
  [DiscoveryEvent.CollectorReceived]: DiscoveryCollectorReceivedEvent;
  [DiscoveryEvent.CollectorInvalid]: DiscoveryCollectorInvalidEvent;
  [DiscoveryEvent.CollectorApplied]: DiscoveryCollectorAppliedEvent;
  [DiscoveryEvent.CollectorFailed]: DiscoveryCollectorFailedEvent;
  [DiscoveryEvent.ComposerApplied]: DiscoveryComposerAppliedEvent;
  [DiscoveryEvent.ComposerFailed]: DiscoveryComposerFailedEvent;
  [DiscoveryEvent.RunCompleted]: DiscoveryRunCompletedEvent;
  [DiscoveryEvent.RunFailed]: DiscoveryRunFailedEvent;
}
