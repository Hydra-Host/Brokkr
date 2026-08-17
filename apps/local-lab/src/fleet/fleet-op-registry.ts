import { ConflictException, Injectable } from '@nestjs/common';

import { RunnerService } from '../runner/runner.service';

// Kept in lockstep with the stack op catalog by fleet-op-guard.spec.ts's parity spec: every op whose
// section is 'fleet' (or lists 'fleet' in its sections), excluding the read-only status group.
export const FLEET_MUTATING_STACK_OP_IDS: ReadonlySet<string> = new Set([
  'fleet-up',
  'fleet-down',
  'fleet-rebuild',
  'fleet-apply',
  'fleet-mode-apply',
  'fleet-add-commissioning',
  'fleet-nuke',
  'reinit',
  'reset',
  'purge',
]);

export type FleetOpScope = { kind: 'node'; name: string } | { kind: 'fleet' };

export interface FleetOpLease {
  readonly key: string;
  bind(runId: string): void;
  release(): void;
}

interface LeaseRecord {
  label: string;
  runId: string | null;
}

@Injectable()
export class FleetOpRegistry {
  private readonly leases = new Map<string, LeaseRecord>();

  constructor(private readonly runner: RunnerService) {}

  acquire(scope: FleetOpScope, label: string): FleetOpLease {
    const stackOp = this.runner
      .list('stack')
      .find((r) => r.status === 'running' && FLEET_MUTATING_STACK_OP_IDS.has(r.opId));
    if (stackOp)
      throw new ConflictException(
        `fleet busy: stack op '${stackOp.label}' is running (runId=${stackOp.runId}) — wait for it or stop it first.`,
      );

    const key = scope.kind === 'fleet' ? 'fleet' : `node:${scope.name}`;
    const conflict = this.conflictingLease(scope, key);
    if (conflict)
      throw new ConflictException(
        `fleet busy: '${conflict.label}' is already running (runId=${conflict.runId ?? 'pending'}) — wait for it or cancel it.`,
      );

    const record: LeaseRecord = { label, runId: null };
    this.leases.set(key, record);
    return {
      key,
      bind: (runId: string) => {
        record.runId = runId;
      },
      // identity-guarded so a stale release can never evict a successor lease that reused the key.
      release: () => {
        if (this.leases.get(key) === record) this.leases.delete(key);
      },
    };
  }

  private conflictingLease(scope: FleetOpScope, key: string): LeaseRecord | undefined {
    if (scope.kind === 'fleet') {
      const first = this.leases.values().next();
      return first.done ? undefined : first.value;
    }
    return this.leases.get('fleet') ?? this.leases.get(key);
  }
}
