// Holder indirection breaks the dispatcher↔upgrade-service DI cycle; AgentUpgradeServiceModule sets the callable once the service exists.

export interface UpgradeTriggerArgs {
  deviceId: string;
  currentVersion: string;
  expectedVersion: string;
  jobId: string | null;
}

export type UpgradeTriggerFn = (args: UpgradeTriggerArgs) => Promise<unknown>;

let trigger: UpgradeTriggerFn | null = null;

export function setUpgradeTrigger(fn: UpgradeTriggerFn): void {
  trigger = fn;
}

export function getUpgradeTrigger(): UpgradeTriggerFn | null {
  return trigger;
}

export function resetUpgradeTriggerForTests(): void {
  trigger = null;
}
