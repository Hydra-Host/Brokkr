// Cross-module seam (mirrors getLeaderService): bridge-local saga enqueuers live outside the module
// that owns PlanManagerService, so they persist a plan through this holder instead of a direct dep.
export interface BridgeLocalPlanPersister {
  // Persist the initial plan for a bridge-local saga so its worker doesn't fail closed on pickup.
  // Idempotent (no-op if already persisted); false when the saga is unknown.
  persistInitialPlan(planId: string, sagaName: string, deviceId: unknown, queueName: string): Promise<boolean>;
}

export type PlanPersisterProvider = () => BridgeLocalPlanPersister | null;

export const PLAN_PERSISTER_PROVIDER = Symbol('PLAN_PERSISTER_PROVIDER');

let instance: BridgeLocalPlanPersister | null = null;

export function getPlanManager(): BridgeLocalPlanPersister | null {
  return instance;
}

export function setPlanManager(persister: BridgeLocalPlanPersister | null): void {
  instance = persister;
}
