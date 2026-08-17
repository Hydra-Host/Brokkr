import { JobType, LifecycleJobPhase } from '@repo/database';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  assertTransition,
  canTransition,
  IllegalPhaseTransitionError,
  nextPhaseForBridge,
} from '../lifecycle-state.machine';

const ALL_PHASES = Object.values(LifecycleJobPhase);
const TERMINAL = [LifecycleJobPhase.COMPLETED, LifecycleJobPhase.FAILED, LifecycleJobPhase.ABORTED];

describe('lifecycle state machine', () => {
  describe('ALLOWED_TRANSITIONS / assertTransition', () => {
    it('allows every declared forward edge and rejects everything else', () => {
      for (const from of ALL_PHASES) {
        const allowed = ALLOWED_TRANSITIONS[from];
        for (const to of ALL_PHASES) {
          const expected = allowed.includes(to);
          expect(canTransition(from, to)).toBe(expected);
          if (expected) {
            expect(() => assertTransition(from, to)).not.toThrow();
          } else {
            expect(() => assertTransition(from, to)).toThrow(IllegalPhaseTransitionError);
          }
        }
      }
    });

    it('allows AUTHORIZING → DEFERRED (gate park) and DEFERRED → AUTHORIZING / ABORTED only', () => {
      expect(canTransition(LifecycleJobPhase.AUTHORIZING, LifecycleJobPhase.DEFERRED)).toBe(true);
      expect(canTransition(LifecycleJobPhase.DEFERRED, LifecycleJobPhase.AUTHORIZING)).toBe(true);
      expect(canTransition(LifecycleJobPhase.DEFERRED, LifecycleJobPhase.ABORTED)).toBe(true);
      expect(canTransition(LifecycleJobPhase.DEFERRED, LifecycleJobPhase.DISPATCHED)).toBe(false);
      expect(canTransition(LifecycleJobPhase.REQUESTED, LifecycleJobPhase.DEFERRED)).toBe(false);
    });

    it('treats terminal phases as having no outgoing edges', () => {
      for (const phase of TERMINAL) {
        expect(ALLOWED_TRANSITIONS[phase]).toEqual([]);
      }
    });

    it('rejects an unset (undefined) starting phase', () => {
      expect(canTransition(undefined, LifecycleJobPhase.AUTHORIZING)).toBe(false);
      expect(() => assertTransition(undefined, LifecycleJobPhase.AUTHORIZING)).toThrow(IllegalPhaseTransitionError);
    });

    it('carries from/to on the thrown error', () => {
      try {
        assertTransition(LifecycleJobPhase.COMPLETED, LifecycleJobPhase.RUNNING);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(IllegalPhaseTransitionError);
        const e = error as IllegalPhaseTransitionError;
        expect(e.from).toBe(LifecycleJobPhase.COMPLETED);
        expect(e.to).toBe(LifecycleJobPhase.RUNNING);
      }
    });
  });

  describe('nextPhaseForBridge', () => {
    it('maps a job_failed event to FAILED regardless of jobType/status', () => {
      expect(nextPhaseForBridge(JobType.Provision, LifecycleJobPhase.RUNNING, 'job_failed', 'whatever')).toBe(
        LifecycleJobPhase.FAILED,
      );
      expect(nextPhaseForBridge(JobType.Deprovision, LifecycleJobPhase.DISPATCHED, 'job_failed', '')).toBe(
        LifecycleJobPhase.FAILED,
      );
    });

    it('sends provision-family completion to AWAITING_PHONE_HOME', () => {
      for (const jobType of [JobType.Provision, JobType.Reprovision]) {
        expect(nextPhaseForBridge(jobType, LifecycleJobPhase.RUNNING, 'job_completed', 'complete')).toBe(
          LifecycleJobPhase.AWAITING_PHONE_HOME,
        );
      }
    });

    it('completes non-provision jobs directly on saga completion', () => {
      for (const jobType of [JobType.Deprovision, JobType.Reboot, JobType.PowerOn, JobType.PowerOff]) {
        expect(nextPhaseForBridge(jobType, LifecycleJobPhase.RUNNING, 'job_completed', 'complete')).toBe(
          LifecycleJobPhase.COMPLETED,
        );
      }
    });

    it('fails on a non-complete job_completed status', () => {
      expect(nextPhaseForBridge(JobType.Provision, LifecycleJobPhase.RUNNING, 'job_completed', 'failed')).toBe(
        LifecycleJobPhase.FAILED,
      );
    });

    it('moves DISPATCHED → RUNNING on the first stage_changed, then holds', () => {
      expect(nextPhaseForBridge(JobType.Provision, LifecycleJobPhase.DISPATCHED, 'stage_changed', 'running')).toBe(
        LifecycleJobPhase.RUNNING,
      );
      expect(nextPhaseForBridge(JobType.Provision, LifecycleJobPhase.RUNNING, 'stage_changed', 'running')).toBeNull();
    });

    it('advances a rewound job (SCHEDULED/AUTHORIZING) on stage_changed — the message proves dispatch ran', () => {
      expect(nextPhaseForBridge(JobType.Deprovision, LifecycleJobPhase.SCHEDULED, 'stage_changed', 'running')).toBe(
        LifecycleJobPhase.RUNNING,
      );
      expect(nextPhaseForBridge(JobType.Deprovision, LifecycleJobPhase.AUTHORIZING, 'stage_changed', 'running')).toBe(
        LifecycleJobPhase.RUNNING,
      );
      expect(
        nextPhaseForBridge(JobType.Deprovision, LifecycleJobPhase.REQUESTED, 'stage_changed', 'running'),
      ).toBeNull();
    });
  });
});
