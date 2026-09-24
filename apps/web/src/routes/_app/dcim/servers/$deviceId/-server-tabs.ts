import type { ServerTab, TabGatePasses } from '@repo/domain-ui/hooks/server-tabs';

/** Passes when either job gate passes; the console serves both audiences. */
export type ServerTabGate = 'jobs';

export const SERVER_TABS: readonly ServerTab<ServerTabGate>[] = [
  { name: 'Overview', segment: '' },
  { name: 'Networking', segment: 'networking' },
  { name: 'BMC Secrets', segment: 'bmc-secrets' },
  { name: 'Provision', segment: 'provision' },
  { name: 'Invite', segment: 'invite' },
  { name: 'Test Runs', segment: 'test-runs' },
  { name: 'Discovery Runs', segment: 'discovery-runs' },
  { name: 'Diagnostics', segment: 'diagnostics' },
  { name: 'Jobs', segment: 'jobs', gate: 'jobs' },
  { name: 'Settings', segment: 'settings' },
];

export interface ServerTabGates {
  canAccessJobLogs: boolean;
  canViewJobs: boolean;
}

export const GATE_PASSES: TabGatePasses<ServerTabGate, ServerTabGates> = {
  jobs: (gates) => gates.canAccessJobLogs || gates.canViewJobs,
};
